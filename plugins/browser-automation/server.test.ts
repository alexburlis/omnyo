import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { z } from "zod";
import {
  rpcContract,
  hostContract,
  type RunOutput,
  type RuntimeState,
} from "./contracts.js";

type HostOutput =
  | RuntimeState
  | RunOutput
  | z.output<typeof hostContract.preview.output>
  | null;

type FakeTab = { tabId: string; control: { leaseId: string } | null };

type TabChangeListener = (result: { tabs: FakeTab[] }) => void;

const leased = { leaseId: "lease" };

async function setup() {
  const desktopTabs: FakeTab[] = [{ tabId: "created", control: null }];
  const tabChangeListeners: TabChangeListener[] = [];

  const worker = vi.fn(
    async ({
      method,
    }: {
      method: string;
      hostId: string;
      signal?: AbortSignal;
      input?: unknown;
    }): Promise<HostOutput> =>
      method === "run"
        ? { text: "done", images: [], exitCode: 0 }
        : method === "prepare"
          ? { status: "ready", version: "1.0.0-test", source: "release" }
          : null,
  );

  const host = createFakePluginHost({
    pluginId: "browser-automation",
    agentSkillIds: ["browser-automation"],
    experimental_callHostRpc: worker,
  });

  host.harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({ id: "thread-test" }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.listInstances",
    async () => ({
      instances: [
        {
          hostId: "desktop-host",
          instanceId: "desktop",
          generation: "generation",
          label: "Desktop",
        },
      ],
    }),
  );
  host.harness.sdk.stub("experimental_desktopBrowsers.createTab", async () => ({
    tab: {
      tabId: "created",
      threadId: "thread-test",
      url: "about:blank",
      title: "",
      control: null,
      presentation: "hidden",
    },
  }));
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.acquireControl",
    async () => ({ leaseId: "lease", expiresAt: Date.now() + 60_000 }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.openConnection",
    async () => ({
      hostId: "desktop-host",
      expiresAt: Date.now() + 60_000,
      wsEndpoint: "ws://127.0.0.1:9999/cdp?token=secret",
    }),
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.releaseControl",
    async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        "generation",
        "hostId",
        "instanceId",
        "leaseId",
        "threadId",
      ]);

      return { ok: true };
    },
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.closeTab",
    async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        "generation",
        "hostId",
        "instanceId",
        "tabId",
        "threadId",
      ]);

      return { ok: true };
    },
  );
  host.harness.sdk.stub(
    "experimental_desktopBrowsers.subscribe",
    (input: { onChange: TabChangeListener }) => {
      tabChangeListeners.push(input.onChange);

      return { dispose() {} };
    },
  );
  host.harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => ({
    tabs: desktopTabs.map((tab) => ({ ...tab })),
  }));
  host.harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: "local-host", name: "Lab workstation" }),
    makeHostResponse({ id: "desktop-host", name: "Lab desktop" }),
  ]);
  await plugin(host.api);

  async function open(tabId?: string) {
    const result = await host.harness.behavior.callRpc("open", {
      threadId: "thread-test",
      selection: {
        backend: "desktop",
        hostId: "desktop-host",
        instanceId: "desktop",
        ...(tabId ? { tabId } : {}),
      },
    });

    return rpcContract.open.output.parse(result);
  }

  function setTabs(tabs: FakeTab[]) {
    desktopTabs.splice(0, desktopTabs.length, ...tabs);
  }

  function closedTabIds() {
    return host.harness.sdk
      .callsTo("experimental_desktopBrowsers.closeTab")
      .map(([input]) => (input as { tabId: string }).tabId)
      .sort();
  }

  return { ...host, worker, open, setTabs, closedTabIds, tabChangeListeners };
}

describe("server session ownership", () => {
  it.each([
    ["local", "Lab workstation", "local-host"],
    ["desktop", "Lab desktop", "desktop-host"],
    ["local", "local-host", "local-host"],
  ])(
    "resolves %s machine selector %s before opening",
    async (backend, target, hostId) => {
      const h = await setup();

      try {
        const result = await h.harness.behavior.runCli(
          [
            "open",
            "--backend",
            backend,
            "--machine",
            target,
            ...(backend === "local"
              ? ["--headless"]
              : ["--desktop", "desktop"]),
            "--json",
          ],
          { threadId: "thread-test" },
        );

        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ hostId });
        expect(h.worker).toHaveBeenCalledWith(
          expect.objectContaining({ method: "prepare", hostId }),
        );
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );

  it("prefers an exact machine ID over a matching name", async () => {
    const h = await setup();
    h.harness.sdk.stub("hosts.list", async () => [
      makeHostResponse({ id: "other-host", name: "local-host" }),
      makeHostResponse({ id: "local-host", name: "Lab workstation" }),
    ]);

    try {
      const result = await h.harness.behavior.runCli(
        [
          "open",
          "--backend",
          "local",
          "--machine",
          " local-host ",
          "--headless",
          "--json",
        ],
        { threadId: "thread-test" },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ hostId: "local-host" });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it.each([
    ["Shared lab", "ambiguous"],
    ["Missing lab", "not found"],
  ])(
    "rejects machine selector %s before creating a session",
    async (target, message) => {
      const h = await setup();
      h.harness.sdk.stub("hosts.list", async () => [
        makeHostResponse({ id: "host-a", name: "Shared lab" }),
        makeHostResponse({ id: "host-b", name: "Shared lab" }),
      ]);

      try {
        const result = await h.harness.behavior.runCli(
          [
            "open",
            "--backend",
            "local",
            "--machine",
            target,
            "--headless",
            "--json",
          ],
          { threadId: "thread-test" },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
        expect(h.worker).not.toHaveBeenCalled();
        expect(
          await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
        ).toEqual([]);
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );

  it("saves screenshots in the chat's storage so closing the session keeps them", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      const writes: unknown[] = [];

      h.harness.sdk.stub("threads.storageLocation", async () => ({
        hostId: "storage-host",
        storageRootPath: "/storage/thread-test",
      }));
      h.harness.sdk.stub("files.read", async (input) => {
        expect(input).toMatchObject({
          hostId: "desktop-host",
          path: "/tmp/browser-session/tmp/capture.jpg",
        });

        return {
          content: "/9j/AA==",
          contentEncoding: "base64",
          sha256: "sha",
          size: 4,
        };
      });
      h.harness.sdk.stub("files.write", async (input) => {
        writes.push(input);

        return { sha256: "sha", size: 4 };
      });

      h.worker.mockResolvedValueOnce({
        text: "captured",
        images: [
          {
            path: "/tmp/browser-session/tmp/capture.jpg",
            mimeType: "image/jpeg",
            width: 640,
            height: 400,
          },
        ],
        exitCode: 0,
      });

      const result = await h.harness.behavior.runCli(
        ["screenshot", session.id, "--json"],
        { threadId: "thread-test" },
      );

      expect(result.exitCode).toBe(0);
      const printed = JSON.parse(result.stdout);
      expect(printed.hostId).toBe("storage-host");
      expect(printed.images).toHaveLength(1);
      expect(printed.images[0]).toMatchObject({ width: 640, height: 400 });
      expect(printed.images[0].path).toMatch(
        new RegExp(
          `^/storage/thread-test/Screenshots/${session.id}-\\d+-1\\.jpg$`,
        ),
      );
      expect(writes).toEqual([
        {
          hostId: "storage-host",
          rootPath: "/storage/thread-test",
          path: printed.images[0].path,
          content: "/9j/AA==",
          contentEncoding: "base64",
          createParents: true,
        },
      ]);
      expect(h.harness.registrations.agentTools).toEqual([]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("routes to the desktop host without exposing the connection and preserves a handed-off tab", async () => {
    const h = await setup();

    try {
      const session = await h.open("handed-off");
      expect(JSON.stringify(session)).not.toContain("secret");
      expect(h.worker).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "desktop-host",
          method: "open",
          input: expect.objectContaining({
            connectionUrl: "ws://127.0.0.1:9999/cdp?token=secret",
          }),
        }),
      );
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: session.id,
      });
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
      ).toHaveLength(0);
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("closes pages the agent opened under its lease and keeps the user's tabs", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      h.setTabs([
        { tabId: "created", control: leased },
        { tabId: "popup", control: leased },
        { tabId: "user", control: null },
      ]);
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: session.id,
      });
      expect(h.closedTabIds()).toEqual(["created", "popup"]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("closes pages opened during a handoff but keeps the handed-off tab", async () => {
    const h = await setup();

    try {
      const session = await h.open("handed-off");
      h.setTabs([
        { tabId: "handed-off", control: leased },
        { tabId: "popup", control: leased },
        { tabId: "user", control: null },
      ]);
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: session.id,
      });
      expect(h.closedTabIds()).toEqual(["popup"]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("remembers leased pages after the lease is lost so close still disposes them", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      const [onChange] = h.tabChangeListeners;
      onChange({
        tabs: [
          { tabId: "created", control: leased },
          { tabId: "popup", control: leased },
        ],
      });
      h.setTabs([
        { tabId: "created", control: null },
        { tabId: "popup", control: null },
        { tabId: "user", control: null },
      ]);
      onChange({ tabs: [] });
      await vi.waitFor(async () => {
        const sessions = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", {
            threadId: "thread-test",
          }),
        );

        expect(sessions.find((entry) => entry.id === session.id)?.state).toBe(
          "stopped",
        );
      });
      expect(h.closedTabIds()).toEqual([]);
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: session.id,
      });
      expect(h.closedTabIds()).toEqual(["created", "popup"]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("denies cross-thread RPC and CLI access before calling the worker", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      await expect(
        h.harness.behavior.callRpc("run", {
          threadId: "other",
          sessionId: session.id,
          script: "1",
        }),
      ).rejects.toThrow();

      const denied = await h.harness.behavior.runCli(
        ["run", session.id, "--thread", "thread-test", "--script", "1"],
        { threadId: "other" },
      );

      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain("another thread");
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "run"),
      ).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it.each(["thread.archived", "thread.deleted", "thread.failed"] as const)(
    "%s closes only the owning thread's sessions",
    async (event) => {
      const h = await setup();

      try {
        const session = await h.open("handed-off");

        const other = rpcContract.open.output.parse(
          await h.harness.behavior.callRpc("open", {
            threadId: "other",
            selection: { backend: "local", hostId: "local-host" },
          }),
        );

        await h.harness.behavior.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse({ id: "thread-test" }),
          lastAssistantText: null,
        });
        expect(
          h.worker.mock.calls.filter(([call]) => call.method === "close"),
        ).toHaveLength(0);
        await h.harness.behavior.emitThreadEvent(event, {
          thread: makeThreadResponse({ id: "thread-test" }),
          error: null,
        });

        const own = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
        );

        const remaining = rpcContract.list.output.parse(
          await h.harness.behavior.callRpc("list", { threadId: "other" }),
        );

        expect(own.find((entry) => entry.id === session.id)?.state).toBe(
          "closed",
        );
        expect(remaining.find((entry) => entry.id === other.id)?.state).toBe(
          "ready",
        );
        expect(
          h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
        ).toHaveLength(0);
      } finally {
        await h.harness.lifecycle.dispose();
      }
    },
  );
  it("concurrent stop and close leave the session closed", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      const input = { threadId: "thread-test", sessionId: session.id };
      await Promise.all([
        h.harness.behavior.callRpc("stop", input),
        h.harness.behavior.callRpc("close", input),
      ]);

      const sessions = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );

      expect(sessions.find((entry) => entry.id === session.id)?.state).toBe(
        "closed",
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("waits for the browser host to finish installing the runtime before opening", async () => {
    const h = await setup();

    try {
      let polls = 0;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "prepare")
          return ++polls < 3
            ? { status: "installing", detail: `step ${polls}` }
            : { status: "ready", version: "1.0.0-test", source: "release" };

        return null;
      });
      await h.open();
      const methods = h.worker.mock.calls.map(([call]) => call.method);
      expect(methods.filter((method) => method === "prepare")).toHaveLength(3);
      expect(methods.indexOf("open")).toBeGreaterThan(
        methods.lastIndexOf("prepare"),
      );
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("cleans up a newly created tab when worker launch fails", async () => {
    const h = await setup();

    try {
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "open") throw new Error("failed startup");

        if (method === "prepare")
          return { status: "ready", version: "1.0.0-test", source: "release" };

        return null;
      });
      await expect(h.open()).rejects.toThrow("failed startup");
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.closeTab"),
      ).toHaveLength(1);
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("server session cleanup", () => {
  const ready = {
    status: "ready",
    version: "1.0.0-test",
    source: "release",
  } satisfies RuntimeState;

  const ownedBy = (sessionId: string) => ({
    threadId: "thread-test",
    sessionId,
  });

  async function openLocal(
    h: Awaited<ReturnType<typeof setup>>,
    hostId = "local-host",
  ) {
    return rpcContract.open.output.parse(
      await h.harness.behavior.callRpc("open", {
        threadId: "thread-test",
        selection: { backend: "local", hostId },
      }),
    );
  }

  async function listed(h: Awaited<ReturnType<typeof setup>>, id: string) {
    const sessions = rpcContract.list.output.parse(
      await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
    );

    return sessions.find((entry) => entry.id === id);
  }

  const hostCalls = (h: Awaited<ReturnType<typeof setup>>, method: string) =>
    h.worker.mock.calls.filter(([call]) => call.method === method);

  it.each(["before", "after", "both"] as const)(
    "keeps a session usable when renewal persistence fails %s execution",
    async (failureAt) => {
      const h = await setup();
      const persist = vi.spyOn(h.api.storage.kv, "set");

      try {
        const session = await openLocal(h);
        const storageError = new Error("renewal write unavailable");

        if (failureAt === "before") persist.mockRejectedValueOnce(storageError);

        if (failureAt === "both") persist.mockRejectedValue(storageError);

        if (failureAt === "after")
          h.worker.mockImplementationOnce(async () => {
            persist.mockRejectedValueOnce(storageError);

            return { text: "done", images: [], exitCode: 0 };
          });
        const input = { ...ownedBy(session.id), script: "1" };

        const outcome = await h.harness.behavior.callRpc("run", input).then(
          (result) => ({ result }),
          (error: unknown) => ({ error: String(error) }),
        );

        expect({ outcome, closes: hostCalls(h, "close").length }).toEqual({
          outcome: { result: { text: "done", images: [], exitCode: 0 } },
          closes: 0,
        });
        persist.mockRestore();
        await expect(h.harness.behavior.callRpc("run", input)).resolves.toEqual(
          {
            text: "done",
            images: [],
            exitCode: 0,
          },
        );
        expect((await listed(h, session.id))?.state).toBe("ready");
      } finally {
        persist.mockRestore();
        await h.harness.lifecycle.dispose();
      }
    },
  );

  it("renews real operations beyond 30 minutes and closes after 30 minutes idle", async () => {
    vi.useFakeTimers();
    const h = await setup();

    try {
      const session = await openLocal(h);

      expect(hostCalls(h, "open")[0]?.[0]).toMatchObject({
        input: {
          expiresAt: session.createdAt + 8 * 60 * 60_000,
          idleTimeoutMs: 30 * 60_000,
        },
      });

      for (const [index, method] of ["run", "pages", "screenshot"].entries()) {
        vi.setSystemTime(session.createdAt + (index + 1) * 20 * 60_000);
        await h.harness.behavior.callRpc(method, {
          ...ownedBy(session.id),
          ...(method === "run" ? { script: "1" } : {}),
        });
        expect((await listed(h, session.id))?.expiresAt).toBe(
          Date.now() + 30 * 60_000,
        );
      }

      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect((await listed(h, session.id))?.state).toBe("ready");
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("does not let list or automatic preview polling keep an abandoned session alive", async () => {
    vi.useFakeTimers();
    const h = await setup();

    try {
      const session = await openLocal(h);
      h.worker.mockResolvedValue({ frame: null });
      vi.setSystemTime(session.createdAt + 29 * 60_000);
      await h.harness.behavior.callRpc("preview", ownedBy(session.id));
      expect((await listed(h, session.id))?.expiresAt).toBe(session.expiresAt);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("caps renewal at eight hours and closes work still running at the cap", async () => {
    vi.useFakeTimers();
    const h = await setup();

    try {
      const session = await openLocal(h);
      const input = { ...ownedBy(session.id), script: "1" };

      for (let minute = 20; minute <= 460; minute += 20) {
        vi.setSystemTime(session.createdAt + minute * 60_000);
        await h.harness.behavior.callRpc("run", input);
      }

      const deadline = session.createdAt + 8 * 60 * 60_000;
      expect((await listed(h, session.id))?.expiresAt).toBe(deadline);
      vi.setSystemTime(deadline - 60_000);
      let finishRun!: () => void;

      const started = new Promise<void>((resolve) => {
        h.worker.mockImplementation(async ({ method }) => {
          if (method === "run") {
            resolve();
            await new Promise<void>((done) => (finishRun = done));

            return { text: "done", images: [], exitCode: 0 };
          }

          return null;
        });
      });

      const running = h.harness.behavior.callRpc("run", input);
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await listed(h, session.id))?.state).toBe("closed");
      finishRun();
      await running;
      await expect(h.harness.behavior.callRpc("run", input)).rejects.toThrow(
        "stopped or expired",
      );
    } finally {
      await h.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["run", "preview"])(
    "rejects expired %s before the cleanup timer runs",
    async (method) => {
      vi.useFakeTimers();
      const h = await setup();

      try {
        const session = await openLocal(h);
        vi.setSystemTime(session.expiresAt);

        const operation = h.harness.behavior.callRpc(method, {
          ...ownedBy(session.id),
          ...(method === "run" ? { script: "1" } : {}),
        });

        if (method === "run")
          await expect(operation).rejects.toThrow("expired");
        else expect(await operation).toMatchObject({ frame: null });
        expect(hostCalls(h, method)).toHaveLength(0);
        expect((await listed(h, session.id))?.expiresAt).toBe(
          session.expiresAt,
        );
      } finally {
        await h.harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    [10 * 60_000, 20 * 60_000],
    [20 * 60_000, 10 * 60_000],
  ])(
    "preserves the earlier desktop lease (%i) or connection (%i) deadline",
    async (leaseMs, connectionMs) => {
      vi.useFakeTimers();
      const h = await setup();

      try {
        h.harness.sdk.stub(
          "experimental_desktopBrowsers.acquireControl",
          async () => ({
            leaseId: "lease",
            expiresAt: Date.now() + leaseMs,
          }),
        );
        h.harness.sdk.stub(
          "experimental_desktopBrowsers.openConnection",
          async () => ({
            hostId: "desktop-host",
            expiresAt: Date.now() + connectionMs,
            wsEndpoint: "ws://127.0.0.1:9999/cdp",
          }),
        );
        const session = await h.open();
        expect(session.expiresAt).toBe(session.createdAt + 10 * 60_000);

        expect(hostCalls(h, "open")[0]?.[0]).toMatchObject({
          input: { expiresAt: session.expiresAt },
        });
        vi.setSystemTime(session.expiresAt - 60_000);
        await h.harness.behavior.callRpc("run", {
          ...ownedBy(session.id),
          script: "1",
        });
        expect((await listed(h, session.id))?.expiresAt).toBe(
          session.expiresAt,
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await listed(h, session.id))?.state).toBe("closed");
      } finally {
        await h.harness.lifecycle.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("rejects close when the host cannot release the browser and retries on the next close", async () => {
    const h = await setup();

    try {
      const flaky = await openLocal(h, "flaky-host");
      const other = await openLocal(h);
      h.worker.mockImplementation(async ({ method, hostId }) => {
        if (method === "close" && hostId === "flaky-host")
          throw new Error("profile directory busy");

        return null;
      });
      await expect(
        h.harness.behavior.callRpc("close", ownedBy(flaky.id)),
      ).rejects.toThrow("profile directory busy");
      expect((await listed(h, flaky.id))?.state).toBe("closed");
      expect((await listed(h, other.id))?.state).toBe("ready");
      await expect(
        h.harness.behavior.callRpc("run", {
          ...ownedBy(flaky.id),
          script: "1",
        }),
      ).rejects.toThrow("stopped or expired");
      await expect(
        h.harness.behavior.callRpc("stop", ownedBy(flaky.id)),
      ).rejects.toThrow("Browser session closed");
      h.worker.mockImplementation(async () => null);
      expect(
        await h.harness.behavior.callRpc("close", ownedBy(flaky.id)),
      ).toMatchObject({ state: "closed" });
      await h.harness.behavior.callRpc("close", ownedBy(flaky.id));
      expect(hostCalls(h, "close")).toHaveLength(3);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("shares one cleanup outcome across concurrent closes", async () => {
    const h = await setup();

    try {
      const session = await openLocal(h);
      let failHost!: () => void;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "close")
          await new Promise<void>(
            (_resolve, reject) =>
              (failHost = () => reject(new Error("browser still running"))),
          );

        return null;
      });

      const outcomes = Promise.allSettled([
        h.harness.behavior.callRpc("close", ownedBy(session.id)),
        h.harness.behavior.callRpc("close", ownedBy(session.id)),
      ]);

      await vi.waitFor(() => expect(hostCalls(h, "close")).toHaveLength(1));
      failHost();
      expect(
        (await outcomes).map((outcome) =>
          outcome.status === "rejected" ? String(outcome.reason) : "resolved",
        ),
      ).toEqual([
        expect.stringContaining("browser still running"),
        expect.stringContaining("browser still running"),
      ]);
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("aborts a host startup that completes after close", async () => {
    const h = await setup();

    try {
      let finishStartup!: () => void;
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "prepare") return ready;

        if (method === "open")
          await new Promise<void>((resolve) => (finishStartup = resolve));

        return null;
      });

      const opening = h.harness.behavior.callRpc("open", {
        threadId: "thread-test",
        selection: { backend: "local", hostId: "local-host" },
      });

      const rejected = expect(opening).rejects.toThrow();
      await vi.waitFor(() => expect(hostCalls(h, "open")).toHaveLength(1));

      const [session] = rpcContract.list.output.parse(
        await h.harness.behavior.callRpc("list", { threadId: "thread-test" }),
      );

      expect(
        await h.harness.behavior.callRpc("close", ownedBy(session!.id)),
      ).toMatchObject({ state: "closed" });
      expect(hostCalls(h, "open")[0]![0].signal?.aborted).toBe(true);
      finishStartup();
      await rejected;
      expect((await listed(h, session!.id))?.state).toBe("closed");
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("releases deleted-thread sessions without calling public-thread browser APIs", async () => {
    const h = await setup();

    try {
      const session = await h.open();
      h.harness.sdk.stub("experimental_desktopBrowsers.listTabs", async () => {
        throw new Error(
          "Public thread browser API must not run after deletion",
        );
      });
      await h.harness.behavior.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: "thread-test" }),
      });
      expect(hostCalls(h, "close")).toHaveLength(1);
      expect(
        h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
      ).toHaveLength(1);
      expect(
        h.harness.logEntries.filter((entry) => entry.level === "warn"),
      ).toEqual([]);
      await h.harness.behavior.callRpc("close", ownedBy(session.id));
      expect(hostCalls(h, "close")).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("recovers a deleted-thread session after restart but retains a failed host cleanup", async () => {
    const h = await setup();
    let current = h;

    try {
      const session = await h.open();
      h.worker.mockImplementation(async ({ method }) => {
        if (method === "close") throw new Error("Host is not connected");

        return null;
      });
      await expect(
        h.harness.behavior.callRpc("close", ownedBy(session.id)),
      ).rejects.toThrow("Host is not connected");
      current = { ...h, ...(await h.harness.lifecycle.reload(plugin)) };
      current.harness.sdk.stub("threads.get", async () => {
        throw Object.assign(new Error("HTTP 404: Thread not found"), {
          status: 404,
          code: "thread_not_found",
        });
      });
      current.harness.sdk.stub(
        "experimental_desktopBrowsers.listTabs",
        async () => {
          throw new Error(
            "Public thread browser API must not run after deletion",
          );
        },
      );
      current.harness.sdk.stub(
        "experimental_desktopBrowsers.releaseControl",
        async () => ({ ok: true }),
      );
      await current.harness.behavior.runService("restart-cleanup").done;
      expect(
        current.harness.logEntries.some((entry) =>
          entry.message.includes("Host is not connected"),
        ),
      ).toBe(true);
      expect(
        current.harness.logEntries.some((entry) =>
          entry.message.includes("desktop to reconnect"),
        ),
      ).toBe(false);
      h.worker.mockImplementation(async () => null);
      current = { ...h, ...(await current.harness.lifecycle.reload(plugin)) };
      current.harness.sdk.stub(
        "experimental_desktopBrowsers.releaseControl",
        async () => ({ ok: true }),
      );
      await current.harness.behavior.runService("restart-cleanup").done;
      const count = hostCalls(h, "close").length;
      await current.harness.behavior.callRpc("close", ownedBy(session.id));
      expect(hostCalls(h, "close")).toHaveLength(count);
    } finally {
      await current.harness.lifecycle.dispose();
    }
  });

  it.each([
    [404, "desktop_not_found"],
    [503, "host_unavailable"],
  ])(
    "keeps restart cleanup pending for an unrelated %i %s lookup failure",
    async (status, code) => {
      const h = await setup();
      let current = h;

      try {
        const session = await h.open();
        h.worker.mockImplementation(async ({ method }) => {
          if (method === "close") throw new Error("Host is not connected");

          return null;
        });
        await expect(
          h.harness.behavior.callRpc("close", ownedBy(session.id)),
        ).rejects.toThrow("Host is not connected");
        h.worker.mockImplementation(async () => null);

        const previousCloses = hostCalls(h, "close").length;

        const previousReleases = h.harness.sdk.callsTo(
          "experimental_desktopBrowsers.releaseControl",
        ).length;

        current = { ...h, ...(await h.harness.lifecycle.reload(plugin)) };
        current.harness.sdk.stub("threads.get", async () => {
          throw Object.assign(new Error("Thread lookup unavailable"), {
            status,
            code,
          });
        });
        await current.harness.behavior.runService("restart-cleanup").done;
        expect(hostCalls(h, "close")).toHaveLength(previousCloses);
        expect(
          h.harness.sdk.callsTo("experimental_desktopBrowsers.releaseControl"),
        ).toHaveLength(previousReleases);
        expect(current.harness.logEntries).toContainEqual({
          level: "warn",
          message: expect.stringContaining("Thread lookup unavailable"),
        });
        current = { ...h, ...(await current.harness.lifecycle.reload(plugin)) };
        current.harness.sdk.stub("threads.get", async () =>
          makeThreadResponse({ id: "thread-test" }),
        );
        current.harness.sdk.stub(
          "experimental_desktopBrowsers.listTabs",
          async () => ({ tabs: [] }),
        );
        current.harness.sdk.stub(
          "experimental_desktopBrowsers.releaseControl",
          async () => ({ ok: true }),
        );
        await current.harness.behavior.runService("restart-cleanup").done;
        expect(hostCalls(h, "close")).toHaveLength(previousCloses + 1);
      } finally {
        await current.harness.lifecycle.dispose();
      }
    },
  );

  it("finishes cleanup that was pending when the plugin restarted", async () => {
    const h = await setup();
    let current = h;

    try {
      const session = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "close" ? new Promise<null>(() => {}) : null,
      );
      void h.harness.behavior
        .callRpc("close", ownedBy(session.id))
        .catch(() => {});
      await vi.waitFor(() => expect(hostCalls(h, "close")).toHaveLength(1));
      h.worker.mockImplementation(async () => null);
      current = { ...h, ...(await h.harness.lifecycle.reload(plugin)) };
      expect(hostCalls(h, "close")).toHaveLength(1);
      await current.harness.behavior.runService("restart-cleanup").done;
      expect(hostCalls(h, "close")).toHaveLength(2);
      expect(
        await current.harness.behavior.callRpc("close", ownedBy(session.id)),
      ).toMatchObject({ state: "closed" });
      expect(hostCalls(h, "close")).toHaveLength(2);
    } finally {
      await current.harness.lifecycle.dispose();
    }
  });

  it("gives the host call a deadline longer than the script timeout", async () => {
    const h = await setup();

    try {
      const session = await openLocal(h);
      await h.harness.behavior.callRpc("run", {
        ...ownedBy(session.id),
        script: "1",
        timeoutMs: 120_000,
      });
      await h.harness.behavior.callRpc("run", {
        ...ownedBy(session.id),
        script: "1",
      });
      await h.harness.behavior.callRpc("pages", ownedBy(session.id));
      await h.harness.behavior.callRpc("screenshot", {
        ...ownedBy(session.id),
        page: "main",
      });
      expect(hostCalls(h, "run").map(([call]) => call)).toMatchObject([
        { input: { timeoutMs: 120_000 }, timeoutMs: 130_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
        { input: { timeoutMs: 30_000 }, timeoutMs: 40_000 },
      ]);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("server live preview", () => {
  const frame = {
    sequence: 7,
    targetId: "preview-target",
    mimeType: "image/jpeg" as const,
    data: Buffer.from("jpeg-bytes").toString("base64"),
    width: 1280,
    height: 720,
    url: "https://example.test/cart",
    title: "Cart",
  };

  async function openLocal(
    h: Awaited<ReturnType<typeof setup>>,
    threadId = "thread-test",
  ) {
    return rpcContract.open.output.parse(
      await h.harness.behavior.callRpc("open", {
        threadId,
        selection: { backend: "local", hostId: "local-host" },
      }),
    );
  }

  it("long-polls the browser host for headless frames only", async () => {
    const h = await setup();

    try {
      const desktop = await h.open();
      const local = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "preview" ? { frame } : null,
      );
      expect(
        await h.harness.behavior.callRpc("preview", {
          threadId: "thread-test",
          sessionId: local.id,
          afterSequence: 6,
          size: "full",
        }),
      ).toEqual({ session: local, frame });
      expect(h.worker).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "local-host",
          method: "preview",
          input: {
            sessionId: local.id,
            afterSequence: 6,
            waitMs: 5_000,
            size: "full",
          },
        }),
      );
      expect(
        await h.harness.behavior.callRpc("preview", {
          threadId: "thread-test",
          sessionId: desktop.id,
        }),
      ).toEqual({ session: desktop, frame: null });
      await expect(
        h.harness.behavior.callRpc("preview", {
          threadId: "other",
          sessionId: local.id,
        }),
      ).rejects.toThrow();
      await h.harness.behavior.callRpc("close", {
        threadId: "thread-test",
        sessionId: local.id,
      });
      expect(
        await h.harness.behavior.callRpc("preview", {
          threadId: "thread-test",
          sessionId: local.id,
        }),
      ).toMatchObject({ session: { state: "closed" }, frame: null });
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "preview"),
      ).toHaveLength(1);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("hands agents an inline preview directive for headless sessions only", async () => {
    const h = await setup();

    try {
      const local = await h.harness.behavior.runCli(
        [
          "open",
          "--backend",
          "local",
          "--headless",
          "--machine",
          "local-host",
          "--json",
        ],
        { threadId: "thread-test" },
      );

      expect(local.exitCode).toBe(0);
      const opened = JSON.parse(local.stdout);
      expect(opened.previewDirective).toBe(
        `::browser-preview{session="${opened.id}"}`,
      );

      const desktop = await h.harness.behavior.runCli(
        [
          "open",
          "--backend",
          "desktop",
          "--machine",
          "desktop-host",
          "--desktop",
          "desktop",
          "--json",
        ],
        { threadId: "thread-test" },
      );

      expect(desktop.exitCode).toBe(0);
      expect(JSON.parse(desktop.stdout)).not.toHaveProperty("previewDirective");

      const agent = await h.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext(),
      );

      expect(agent.skills).toEqual(["browser-automation"]);
      expect(agent.instructions).toMatch(/previewDirective.*exactly once/);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
  it("describes the live frame through the CLI without image bytes", async () => {
    const h = await setup();

    try {
      const local = await openLocal(h);
      h.worker.mockImplementation(async ({ method }) =>
        method === "preview" ? { frame } : null,
      );

      const result = await h.harness.behavior.runCli(
        ["preview", local.id, "--after", "6", "--json"],
        { threadId: "thread-test" },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(frame.data);
      expect(JSON.parse(result.stdout)).toEqual({
        session: local,
        frame: {
          sequence: 7,
          targetId: "preview-target",
          mimeType: "image/jpeg",
          width: 1280,
          height: 720,
          url: frame.url,
          title: "Cart",
          bytes: 10,
        },
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });
});

describe("server visual controls", () => {
  const targetId = "exact-preview-target";

  const viewport = {
    width: 390,
    height: 844,
    scrollX: 0,
    scrollY: 600,
    dpr: 2,
    scale: 1,
  };

  const observation = {
    id: "1a12a3f1-12de-4fbb-a011-df0905678757",
    targetId,
    documentId: "2a12a3f1-12de-4fbb-a011-df0905678757",
    url: "https://fixture.test/",
    title: "Fixture",
    viewport,
    elements: [
      {
        id: "1",
        tag: "button",
        selector: "#save",
        text: "Save",
        rect: { x: 30, y: 100, width: 120, height: 60 },
        styles: {},
      },
    ],
  };

  const image = {
    path: "/owned-session/tmp/crop.jpg",
    mimeType: "image/jpeg",
    width: 240,
    height: 120,
  } as const;

  async function local(h: Awaited<ReturnType<typeof setup>>) {
    return rpcContract.open.output.parse(
      await h.harness.behavior.callRpc("open", {
        threadId: "thread-test",
        selection: { backend: "local", hostId: "local-host" },
      }),
    );
  }

  it("runs visual inspection through the existing worker and reads bytes from that browser host", async () => {
    const h = await setup();

    try {
      const session = await local(h);
      h.harness.sdk.stub("files.read", async () => ({
        contentEncoding: "base64",
        content: "anBlZw==",
        mimeType: "image/jpeg",
        sizeBytes: 4,
      }));
      h.worker.mockImplementation(async ({ method }) =>
        method === "run"
          ? { text: JSON.stringify(observation), images: [image], exitCode: 0 }
          : null,
      );

      const result = rpcContract.observe.output.parse(
        await h.harness.behavior.callRpc("observe", {
          threadId: "thread-test",
          sessionId: session.id,
          targetId,
        }),
      );

      expect(result.observation.targetId).toBe(targetId);
      expect(result.image).toMatchObject({
        hostId: "local-host",
        path: image.path,
        data: "anBlZw==",
      });
      expect(h.harness.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
        hostId: "local-host",
        path: image.path,
      });

      const run = h.worker.mock.calls.find(
        ([call]) => call.method === "run",
      )?.[0];

      expect(run?.hostId).toBe("local-host");
      expect(
        z.object({ script: z.string() }).parse(run?.input).script,
      ).toContain(JSON.stringify(targetId));

      const cli = await h.harness.behavior.runCli(
        ["observe", session.id, "--target", targetId, "--json"],
        { threadId: "thread-test" },
      );

      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).not.toContain("anBlZw==");
      expect(JSON.parse(cli.stdout).image).toMatchObject({
        hostId: "local-host",
        path: image.path,
      });
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("refuses another thread and desktop control before any visual worker call", async () => {
    const h = await setup();

    try {
      const session = await local(h);
      const desktop = await h.open();
      await expect(
        h.harness.behavior.callRpc("observe", {
          threadId: "other",
          sessionId: session.id,
          targetId,
        }),
      ).rejects.toThrow();
      await expect(
        h.harness.behavior.callRpc("observe", {
          threadId: "thread-test",
          sessionId: desktop.id,
          targetId,
        }),
      ).rejects.toThrow(/local headless/);
      expect(
        h.worker.mock.calls.filter(([call]) => call.method === "run"),
      ).toHaveLength(0);
    } finally {
      await h.harness.lifecycle.dispose();
    }
  });

  it("serializes viewport ownership admission and restores the exact saved prior emulation", async () => {
    const h = await setup();
    let finish!: () => void;

    try {
      const session = await local(h);
      const previous = { width: 1010, height: 710, deviceScaleFactor: 1 };

      const applied = {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      };

      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });

      h.worker.mockImplementation(async ({ method }) => {
        if (method !== "run") return null;
        await waiting;

        return {
          text: JSON.stringify({ previous, applied, viewport }),
          images: [],
          exitCode: 0,
        };
      });

      const input = {
        threadId: "thread-test",
        sessionId: session.id,
        targetId,
      };

      const first = h.harness.behavior.callRpc("viewport", {
        ...input,
        preset: "phone",
      });

      await vi.waitFor(() =>
        expect(
          h.worker.mock.calls.filter(([call]) => call.method === "run"),
        ).toHaveLength(1),
      );
      await expect(
        h.harness.behavior.callRpc("viewport", { ...input, preset: "tablet" }),
      ).rejects.toThrow(/already in progress/);
      finish();
      await first;
      await h.harness.behavior.callRpc("viewport", {
        ...input,
        preset: "original",
      });

      const last = h.worker.mock.calls
        .filter(([call]) => call.method === "run")
        .at(-1)?.[0];

      const script = z.object({ script: z.string() }).parse(last?.input).script;
      expect(script).toContain(
        `await p.setViewport(${JSON.stringify(previous)})`,
      );
      await expect(
        h.harness.behavior.callRpc("viewport", {
          ...input,
          preset: "original",
        }),
      ).rejects.toThrow(/No preset owned/);
    } finally {
      finish?.();
      await h.harness.lifecycle.dispose();
    }
  });
});
