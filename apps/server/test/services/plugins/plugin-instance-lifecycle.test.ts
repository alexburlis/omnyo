import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createConnection,
  migrate,
  type DbConnection,
  createPendingInteraction,
  getPendingInteraction,
} from "@omnyo/db";

import type { Logger } from "@omnyo/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  invokeServerAccessProvider,
  listServerAccessProviders,
} from "../../../src/services/plugins/plugin-server-access-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { setMaintenanceFrozen } from "../../../src/services/server-move/freeze-state.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { seedThreadFixture } from "../../helpers/seed.js";
import {
  startTestServer,
  testLogger,
  type RunningTestServer,
} from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

interface LifecycleControl {
  generation: number;
  failingGeneration: number | null;
  candidateCleanupGeneration: number | null;
  threadIds: string[];
  formResults: Array<{ generation: number; result: unknown }>;
  rpcSignals: Array<{ generation: number; aborted: boolean }>;
  cliSignals: Array<{ generation: number; aborted: boolean }>;
  closed: Array<{ generation: number; code: number }>;
  candidateCleanup: string[];
  availabilityCalls: number[];
  eventSourceCalls: number[];
  release: Promise<void>;
  disposeGate: Promise<void>;
  candidateDisposeGate: Promise<void>;
  afterRelease: (api: {
    realtime: { publish(channel: string, payload: unknown): void };
  }) => void;
  coreWork: () => void;
}

declare global {
  var __lifecycle: LifecycleControl | undefined;
}

const fixture = `
  import { defineRpcContract } from "@omnyo/plugin-sdk";
  import { z } from "zod";
  export default function plugin(api: any) {
    const control = globalThis.__lifecycle;
    control.generation += 1;
    const generation = control.generation;
    const threadId = control.threadIds[generation - 1];
    if (threadId !== undefined) {
      void api.ui
        .requestInput({ threadId, rendererId: "probe", title: "Probe " + generation, payload: {} })
        .then((result: unknown) => control.formResults.push({ generation, result }));
    }
    api.rpc.register(
      defineRpcContract({
        wait: { input: z.null(), output: z.number() },
        ping: { input: z.null(), output: z.number() },
        bootstrap: {
          experimental_threadBootstrap: true,
          input: z.object({ threadId: z.string() }),
          output: z.object({ generation: z.number(), aborted: z.boolean() }),
        },
      }),
      {
        async wait(_input: null, context: any) {
          await new Promise<void>((resolve) => {
            context.experimental_signal.addEventListener("abort", () => resolve(), { once: true });
            void control.release.then(resolve);
          });
          control.rpcSignals.push({ generation, aborted: context.experimental_signal.aborted });
          return generation;
        },
        ping: () => generation,
        bootstrap: (_input: unknown, context: any) => ({
          generation,
          aborted: context.experimental_signal.aborted,
        }),
      },
    );
    api.cli.register({
      name: "lifecycle",
      summary: "Fixture",
      async run(argv: string[], ctx: any) {
        if (argv[0] === "plugin-bug") {
          setTimeout(() => {
            throw new Error("plugin timer bug");
          }, 0);
          return { exitCode: 0 };
        }
        if (argv[0] === "core-work") {
          control.coreWork();
          return { exitCode: 0 };
        }
        if (argv[0] === "ping") return { exitCode: 0, stdout: String(generation) };
        await control.release;
        control.cliSignals.push({ generation, aborted: ctx.signal.aborted });
        setTimeout(() => control.afterRelease(api), 20);
        return { exitCode: 0 };
      },
    });
    api.http.experimental_websocket(
      "/socket",
      () => ({
        onClose(_socket: any, event: any) {
          control.closed.push({ generation, code: event.code });
        },
      }),
      { auth: "none" },
    );
    api.experimental_serverAccess.register({
      id: "lifecycle-access",
      displayName: "Lifecycle access",
      description: "Fixture",
      availability() {
        control.availabilityCalls.push(generation);
        return { status: "available" };
      },
      async acquire() {
        return { status: "failed", message: "unused" };
      },
      async release() {},
    });
    api.experimental_eventSources.register({
      family: "lifecycle-source",
      label: "Lifecycle source",
      keyFormat: "lifecycle-source:<target>",
      examples: ["lifecycle-source:ready"],
      approval: "none",
      validate: (target: string) => target === "ready" ? null : "Unknown target",
      describe: (target: string) => "Lifecycle " + target,
      poll: {
        everyMs: 60000,
        async check(targets: readonly string[]) {
          control.eventSourceCalls.push(generation);
          await control.release;
          return targets.map((target) => ({ target, result: String(generation) }));
        },
      },
      async proof() {
        control.eventSourceCalls.push(generation);
        return String(generation);
      },
    });
    api.onDispose(() => control.disposeGate);
    if (generation === control.failingGeneration || generation === control.candidateCleanupGeneration) {
      api.onDispose(() => control.candidateCleanup.push("last"));
      api.onDispose(() => {
        control.candidateCleanup.push("throw");
        throw new Error("candidate cleanup failed");
      });
      api.onDispose(async () => {
        await control.candidateDisposeGate;
        control.candidateCleanup.push("first");
      });
    }
    if (generation === control.failingGeneration) throw new Error("candidate failed");
  }
`;

function newControl(): { control: LifecycleControl; release: () => void } {
  let release!: () => void;

  const control: LifecycleControl = {
    generation: 0,
    failingGeneration: null,
    candidateCleanupGeneration: null,
    threadIds: [],
    formResults: [],
    rpcSignals: [],
    cliSignals: [],
    closed: [],
    candidateCleanup: [],
    availabilityCalls: [],
    eventSourceCalls: [],
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
    disposeGate: Promise.resolve(),
    candidateDisposeGate: Promise.resolve(),
    afterRelease: () => {},
    coreWork: () => {},
  };

  return { control, release };
}

async function writeFixture(root: string, brokenHost = false): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "omnyo-plugin-lifecycle",
      version: "0.1.0",
      omnyo: {
        name: "Lifecycle fixture",
        description: "Exercises plugin instance ownership.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(brokenHost ? { host: "./host.ts" } : {}),
      },
    }),
  );
  await writeFile(join(root, "server.ts"), fixture);

  if (brokenHost)
    await writeFile(join(root, "host.ts"), "export const broken = ;");
}

function control(): LifecycleControl {
  const current = globalThis.__lifecycle;

  if (current === undefined) throw new Error("fixture control missing");

  return current;
}

function withUncaughtExceptions(claim: (error: unknown) => boolean): {
  claimed: unknown[];
  unclaimed: unknown[];
  restore(): void;
} {
  const previous = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const claimed: unknown[] = [];
  const unclaimed: unknown[] = [];
  process.on("uncaughtException", (error) => {
    (claim(error) ? claimed : unclaimed).push(error);
  });

  return {
    claimed,
    unclaimed,
    restore() {
      process.removeAllListeners("uncaughtException");

      for (const listener of previous)
        process.on("uncaughtException", listener);
    },
  };
}

describe("plugin instance lifecycle on a running server", () => {
  let server: RunningTestServer;
  let releaseGate: () => void;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    server = await startTestServer();
    const created = newControl();
    releaseGate = created.release;
    globalThis.__lifecycle = created.control;
    await writeFixture(join(server.config.dataDir, "lifecycle-fixture"));
  });

  afterEach(async () => {
    releaseGate();

    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await server.pluginService.stop();
    await server.close();
    globalThis.__lifecycle = undefined;
  });

  async function install(): Promise<void> {
    const entry = await server.pluginService.installPath(
      join(server.config.dataDir, "lifecycle-fixture"),
    );

    expect(entry.status).toBe("running");
  }

  function callRpc(method: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/plugins/lifecycle/rpc/${method}`, {
      method: "POST",
      body: "null",
      headers: { "content-type": "application/json" },
      ...(signal ? { signal } : {}),
    });
  }

  async function openSocket(): Promise<WebSocket> {
    const url = new URL(
      "/api/v1/plugins/lifecycle/http/socket",
      server.baseUrl,
    );

    url.protocol = "ws:";
    const socket = new WebSocket(url);
    sockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    return socket;
  }

  it("keeps the new instance's startup form when a reload disposes the old one", async () => {
    const first = seedThreadFixture(server, { session: { id: "host-1" } });
    const second = seedThreadFixture(server, { session: { id: "host-2" } });
    control().threadIds = [first.thread.id, second.thread.id];
    await install();
    await expect
      .poll(() =>
        server.deps.pendingInteractions.listPendingThreadInteractions(
          first.thread.id,
        ),
      )
      .toHaveLength(1);

    await server.pluginService.reload("lifecycle");

    await expect
      .poll(() => control().formResults)
      .toEqual([
        {
          generation: 1,
          result: { outcome: "cancelled", reason: "plugin-disposed" },
        },
      ]);
    expect(
      server.deps.pendingInteractions
        .listPendingThreadInteractions(second.thread.id)
        .map((interaction) => interaction.status),
    ).toEqual(["pending"]);
  });

  it.each(["factory", "host build"])(
    "disposes a failed initial candidate after a %s failure",
    async (failure) => {
      const root = join(server.config.dataDir, "lifecycle-fixture");

      if (failure === "host build") {
        control().candidateCleanupGeneration = 1;
        await writeFixture(root, true);
      } else {
        control().failingGeneration = 1;
      }

      const entry = await server.pluginService.installPath(root);

      expect(entry.status).toBe("error");
      expect(control().candidateCleanup).toEqual(["first", "throw", "last"]);
    },
  );

  it("interrupts only a rejected candidate's startup form and retains the loaded instance", async () => {
    const first = seedThreadFixture(server, { session: { id: "host-1" } });
    const second = seedThreadFixture(server, { session: { id: "host-2" } });
    control().threadIds = [first.thread.id, second.thread.id];
    await install();
    control().failingGeneration = 2;
    await expect(
      server.pluginService.reload("lifecycle"),
    ).resolves.toMatchObject({ ok: false });
    expect(control().candidateCleanup).toEqual(["first", "throw", "last"]);
    await expect
      .poll(() => control().formResults)
      .toEqual([
        {
          generation: 2,
          result: { outcome: "cancelled", reason: "plugin-disposed" },
        },
      ]);
    expect(
      server.deps.pendingInteractions.listPendingThreadInteractions(
        first.thread.id,
      ),
    ).toHaveLength(1);
    expect(
      server.deps.pendingInteractions.listPendingThreadInteractions(
        second.thread.id,
      ),
    ).toHaveLength(0);
    expect(await (await callRpc("ping")).json()).toEqual({
      ok: true,
      result: 1,
    });
  });

  it("runs private thread bootstrap RPC on its loaded owner with a cancellation context", async () => {
    const { thread } = seedThreadFixture(server, { session: { id: "host-1" } });
    await install();
    expect(
      await server.pluginService.readThreadBootstrap(thread),
    ).toContainEqual({
      pluginId: "lifecycle",
      method: "bootstrap",
      outcome: { ok: true, result: { generation: 1, aborted: false } },
    });
    await server.pluginService.reload("lifecycle");
    expect(
      await server.pluginService.readThreadBootstrap(thread),
    ).toContainEqual({
      pluginId: "lifecycle",
      method: "bootstrap",
      outcome: { ok: true, result: { generation: 2, aborted: false } },
    });
  });

  it("interrupts a plugin's pending rows that have no waiter when it is disabled", async () => {
    const { thread } = seedThreadFixture(server, { session: { id: "host-1" } });
    await install();

    const orphan = createPendingInteraction(server.db, {
      originKind: "plugin",
      pluginId: "lifecycle",
      rendererId: "probe",
      threadId: thread.id,
      turnId: null,
      expiresAt: Date.now() + 60_000,
      payload: JSON.stringify({
        kind: "plugin",
        title: "Left over",
        data: {},
        presentation: {
          label: { pending: "Waiting", completed: "Done" },
          icon: { glyph: "Zap" },
        },
      }),
    });

    await server.pluginService.setEnabled("lifecycle", false);

    expect(getPendingInteraction(server.db, orphan.id)).toMatchObject({
      status: "interrupted",
      statusReason: "plugin-disposed",
    });
  });

  it("aborts an rpc handler's signal when its caller disconnects", async () => {
    await install();
    const caller = new AbortController();
    const pending = callRpc("wait", caller.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    caller.abort();

    await expect
      .poll(() => control().rpcSignals)
      .toEqual([{ generation: 1, aborted: true }]);
    await pending;
  });

  it("aborts an in-flight rpc handler's signal at reload and delivers its answer", async () => {
    await install();
    const pending = callRpc("wait");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.pluginService.reload("lifecycle");

    expect(await (await pending).json()).toEqual({ ok: true, result: 1 });
    expect(control().rpcSignals).toEqual([{ generation: 1, aborted: true }]);
    releaseGate();
    expect(await (await callRpc("wait")).json()).toEqual({
      ok: true,
      result: 2,
    });
    expect(control().rpcSignals.at(-1)).toEqual({
      generation: 2,
      aborted: false,
    });
  });

  it("keeps serving rpc calls from the old instance while a reload disposes it", async () => {
    await install();
    const [provider] = listServerAccessProviders();

    if (provider === undefined) throw new Error("provider not registered");
    let openDisposeGate!: () => void;
    control().disposeGate = new Promise<void>((resolve) => {
      openDisposeGate = resolve;
    });

    const reload = server.pluginService.reload("lifecycle");

    try {
      await expect.poll(() => control().generation).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await (await callRpc("ping")).json()).toEqual({
        ok: true,
        result: 1,
      });
      await expect(
        invokeServerAccessProvider(provider, async () =>
          provider.provider.availability(),
        ),
      ).rejects.toThrow();
      expect(control().availabilityCalls).toEqual([]);
    } finally {
      openDisposeGate();
      await reload;
    }

    expect(await (await callRpc("ping")).json()).toEqual({
      ok: true,
      result: 2,
    });
  });

  it("runs WebSocket onClose handlers on reload and on disable", async () => {
    await install();
    await openSocket();

    await server.pluginService.reload("lifecycle");

    expect(control().closed).toEqual([{ generation: 1, code: 1012 }]);
    await openSocket();

    await server.pluginService.setEnabled("lifecycle", false);

    expect(control().closed).toEqual([
      { generation: 1, code: 1012 },
      { generation: 2, code: 1012 },
    ]);
  });

  it("runs a provider callback only on the instance that registered it", async () => {
    await install();
    const [fromFirst] = listServerAccessProviders();

    if (fromFirst === undefined) throw new Error("provider not registered");

    await server.pluginService.reload("lifecycle");

    await expect(
      invokeServerAccessProvider(fromFirst, async () =>
        fromFirst.provider.availability(),
      ),
    ).rejects.toThrow();
    expect(control().availabilityCalls).toEqual([]);
    const [fromSecond] = listServerAccessProviders();

    if (fromSecond === undefined) throw new Error("provider not registered");
    await expect(
      invokeServerAccessProvider(fromSecond, async () =>
        fromSecond.provider.availability(),
      ),
    ).resolves.toEqual({ status: "available" });
    expect(control().availabilityCalls).toEqual([2]);
  });
});

describe("plugin instance lifecycle without cooperation", () => {
  let workDir: string;
  let releaseGate: () => void;
  let service: PluginService;
  let db: DbConnection;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "omnyo-plugin-lifecycle-"));
    const created = newControl();
    releaseGate = created.release;
    globalThis.__lifecycle = created.control;
    await writeFixture(join(workDir, "lifecycle"));
    db = createConnection(":memory:");
    migrate(db);
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger as unknown as Logger,
      dataDir: join(workDir, "data"),
      vault: await openSecretVault(join(workDir, "data")),
      appVersion: "0.9.0",
      loadTimeoutMs: 5_000,
      serviceStopTimeoutMs: 100,
    });
    const installed = await service.installPath(join(workDir, "lifecycle"));
    expect(installed.status).toBe("running");
  });

  afterEach(async () => {
    releaseGate();
    await service.stop();
    db.$client.close();
    globalThis.__lifecycle = undefined;
    await rm(workDir, { recursive: true, force: true });
  });

  function status() {
    return service.list().find((plugin) => plugin.id === "lifecycle");
  }

  it("finishes a failed reload after a candidate hook hangs", async () => {
    control().failingGeneration = 2;
    control().candidateDisposeGate = new Promise(() => {});

    await expect(service.reload("lifecycle")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("candidate failed"),
    });
    expect(control().candidateCleanup).toEqual(["throw", "last"]);
    expect(
      await service.runCliCommand("lifecycle", ["ping"], {}),
    ).toMatchObject({
      exitCode: 0,
      stdout: "1",
    });
  });

  it("rejects foreign and stale event-source registrations while preserving current owner execution", async () => {
    const [first] = service.eventSources.list();

    if (first === undefined || first.source.proof === null)
      throw new Error("Event source not registered");
    const firstProof = first.source.proof;
    const context = { signal: new AbortController().signal };
    await expect(
      service.eventSources.invoke({ ...first }, "event source proof", () =>
        firstProof(context),
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(control().eventSourceCalls).toEqual([]);
    await expect(
      service.eventSources.invoke(first, "event source proof", () =>
        firstProof(context),
      ),
    ).resolves.toEqual({ ok: true, value: "1" });
    await service.reload("lifecycle");
    await expect(
      service.eventSources.invoke(first, "event source proof", () =>
        firstProof(context),
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(control().eventSourceCalls).toEqual([1]);
    const [current] = service.eventSources.list();

    if (current === undefined || current.source.proof === null)
      throw new Error("New event source not registered");
    const currentProof = current.source.proof;
    await expect(
      service.eventSources.invoke(current, "event source proof", () =>
        currentProof(context),
      ),
    ).resolves.toEqual({ ok: true, value: "2" });
    setMaintenanceFrozen(db, true);

    try {
      await expect(
        service.eventSources.invoke(current, "event source proof", () =>
          currentProof(context),
        ),
      ).resolves.toMatchObject({ ok: false });
      expect(control().eventSourceCalls).toEqual([1, 2]);
    } finally {
      setMaintenanceFrozen(db, false);
    }
  });

  it("keeps event-source work visible during strict owner draining", async () => {
    const [record] = service.eventSources.list();

    if (record === undefined || record.source.poll === null)
      throw new Error("Event source not registered");

    const poll = record.source.poll;

    const pending = service.eventSources.invoke(
      record,
      "event source poll",
      () => poll.check(["ready"], { signal: new AbortController().signal }),
    );

    let outcome: Awaited<typeof pending> | undefined;

    void pending.then((result) => {
      outcome = result;
    });
    await expect
      .poll(() => service.getMaintenanceActivity().pluginInvocations, {
        timeout: 1000,
      })
      .toBe(1);

    const suspension = service
      .suspendPlugins({ keep: () => false, strict: true })
      .then(
        () => ({ stopped: true, error: "" }),
        (error: unknown) => ({
          stopped: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

    let disposed: Awaited<typeof suspension> | undefined;
    void suspension.then((result) => {
      disposed = result;
    });

    try {
      await expect
        .poll(() => disposed, { timeout: 1500 })
        .toMatchObject({
          stopped: false,
          error: expect.stringContaining("did not quiesce"),
        });
      await expect
        .poll(() => outcome, { timeout: 1000 })
        .toMatchObject({ ok: false });
      expect(service.getMaintenanceActivity().pluginInvocations).toBe(1);
    } finally {
      releaseGate();
      await Promise.all([pending, suspension]);
    }

    await expect
      .poll(() => service.getMaintenanceActivity().pluginInvocations, {
        timeout: 1000,
      })
      .toBe(0);
    expect(control().eventSourceCalls).toEqual([1]);
  });

  it("releases a caller the old instance never answers and contains its later stale-handle use", async () => {
    const uncaught = withUncaughtExceptions((error) =>
      service.handleUncaughtException(error),
    );

    control().afterRelease = (api) => api.realtime.publish("changed", null);

    try {
      const command = service.runCliCommand("lifecycle", [], {});
      await new Promise((resolve) => setTimeout(resolve, 50));

      await service.reload("lifecycle");

      expect(service.getMaintenanceActivity().pluginInvocations).toBe(1);
      expect(await command).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining("was reloaded or disabled"),
      });
      expect(
        await service.runCliCommand("lifecycle", ["ping"], {}),
      ).toMatchObject({ exitCode: 0, stdout: "2" });
      releaseGate();
      await expect
        .poll(() => service.getMaintenanceActivity().pluginInvocations)
        .toBe(0);
      await expect.poll(() => uncaught.claimed).toHaveLength(1);
      expect(uncaught.claimed[0]).toMatchObject({
        name: "PluginContextStaleError",
      });
      expect(uncaught.unclaimed).toEqual([]);
      expect(control().cliSignals).toEqual([{ generation: 1, aborted: true }]);
      expect(status()).toMatchObject({ status: "running" });
    } finally {
      uncaught.restore();
    }
  });

  it("keeps maintenance admission held and strict draining visible for retired execution", async () => {
    setMaintenanceFrozen(db, true);
    expect(
      await service.runCliCommand("lifecycle", ["ping"], {}),
    ).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("held for server maintenance"),
    });
    setMaintenanceFrozen(db, false);
    const command = service.runCliCommand("lifecycle", [], {});
    await expect
      .poll(() => service.getMaintenanceActivity().pluginInvocations)
      .toBe(1);
    await expect(
      service.suspendPlugins({ keep: () => false, strict: true }),
    ).rejects.toThrow("did not quiesce");
    expect(await command).toMatchObject({ exitCode: 1 });
    expect(service.getMaintenanceActivity().pluginInvocations).toBe(1);
    releaseGate();
    await expect
      .poll(() => service.getMaintenanceActivity().pluginInvocations)
      .toBe(0);
  });

  it("contains an uncaught error from plugin code and keeps the plugin running", async () => {
    const uncaught = withUncaughtExceptions((error) =>
      service.handleUncaughtException(error),
    );

    try {
      await service.runCliCommand("lifecycle", ["plugin-bug"], {});

      await expect.poll(() => uncaught.claimed).toHaveLength(1);
      expect(uncaught.unclaimed).toEqual([]);
      expect(status()).toMatchObject({
        status: "running",
        statusDetail: expect.stringContaining("plugin timer bug"),
      });
    } finally {
      uncaught.restore();
    }
  });

  it("does not claim errors from core work started during a plugin call", async () => {
    const results: boolean[] = [];
    control().coreWork = () => {
      setTimeout(() => {
        results.push(service.handleUncaughtException(new Error("core bug")));
      }, 0);
    };

    await service.runCliCommand("lifecycle", ["core-work"], {});

    await expect.poll(() => results).toEqual([false]);
    expect(status()).toMatchObject({ status: "running", statusDetail: null });
  });
});
