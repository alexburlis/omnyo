import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  PLUGIN_HOST_REPLACING_ERROR_CODE,
  PluginHostManager,
} from "./plugin-host-manager.js";

const FIXTURE = `
const any = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } };
let retained;
export default {
  experimental_apiVersion: 1,
  contract: {
    hold: { input: any, output: any },
    ping: { input: any, output: any, experimental_hostReplacementKey: "control-v1" },
    cancelJob: { input: any, output: any, experimental_hostReplacementKey: "control-v1" },
    slow: { input: any, output: any, experimental_hostReplacementKey: "control-v1" },
  },
  handlers: {
    async hold(input, context) {
      const lease = context.experimental_retainWorker();
      retained = lease;
      if (input.releaseAfterMs !== null) setTimeout(() => void lease.dispose(), input.releaseAfterMs);
      return { pid: process.pid };
    },
    async ping() {
      return { pid: process.pid };
    },
    async cancelJob() {
      await retained?.dispose();
      return { pid: process.pid };
    },
    async slow(input, context) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, input.ms);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("control cancelled"));
        }, { once: true });
      });
      return { pid: process.pid };
    },
  },
};
`;

const bytes = new TextEncoder().encode(FIXTURE);

const artifact = {
  digest: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.byteLength,
};

const logger = { debug() {}, info() {}, warn() {} };

const managers: PluginHostManager[] = [];

const directories: string[] = [];

let nextCall = 0;

async function createManager(supersededLimitMs?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-leased-host-"));

  directories.push(dataDir);

  const manager = new PluginHostManager({
    dataDir,
    logger,
    fetchArtifact: async () => bytes,
    workerStopGraceMs: 2_000,
    ...(supersededLimitMs === undefined ? {} : { supersededLimitMs }),
  });

  managers.push(manager);

  return manager;
}

async function call(
  manager: PluginHostManager,
  generation: string,
  method: "hold" | "ping" | "slow" | "cancelJob",
  input: Record<string, number | null>,
  replacementKey: string | null = null,
): Promise<number> {
  nextCall += 1;

  const result = await manager.call({
    type: "plugin.host.call",
    contributedEnv: [],
    pluginId: "leased-fixture",
    generation,
    artifact,
    callId: `call-${nextCall}`,
    method,
    input,
    timeoutMs: 10_000,
    ...{ replacementKey },
  });

  const output = result.output;

  if (typeof output !== "object" || output === null || !("pid" in output))
    throw new Error("fixture output has no pid");

  return Number(output.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(check: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 8_000;
  let failure: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw failure;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("keeps a leased worker running when a new generation is called, then switches once its lease ends", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: 1_500 });

  await expect(call(manager, "g2", "ping", {})).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });
  expect(alive(first)).toBe(true);

  const second = await eventually(() => call(manager, "g2", "ping", {}));

  expect(second).not.toBe(first);
  await eventually(async () => {
    if (alive(first)) throw new Error("superseded leased worker still running");
  });
});

it("lets an in-flight call on a leased worker finish while it is being replaced", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: 1_500 });
  const slow = call(manager, "g1", "slow", { ms: 800 });

  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect(call(manager, "g2", "ping", {})).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });
  await expect(slow).resolves.toBe(first);
});

it("permits matching replacement controls without admitting new work", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });

  await expect(call(manager, "g2", "ping", {}, "control-v1")).resolves.toBe(
    first,
  );
  await expect(call(manager, "g2", "ping", {})).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });
  await expect(
    call(manager, "g2", "ping", {}, "control-v2"),
  ).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });
  await expect(
    call(manager, "g2", "hold", { releaseAfterMs: null }, "control-v1"),
  ).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });
  await expect(
    call(manager, "g1", "hold", { releaseAfterMs: null }),
  ).rejects.toThrow("retired");
  await expect(
    call(manager, "g2", "cancelJob", {}, "control-v1"),
  ).resolves.toBe(first);

  const second = await call(manager, "g2", "ping", {});
  expect(second).not.toBe(first);
  expect(alive(first)).toBe(false);
});

it("replaces an unleased worker at once when a new generation is called", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "ping", {});
  const second = await call(manager, "g2", "ping", {});

  expect(second).not.toBe(first);
  expect(alive(first)).toBe(false);
});

it("cancels a replacement control on the actual retiring worker", async () => {
  const manager = await createManager();
  await call(manager, "g1", "hold", { releaseAfterMs: null });
  const id = nextCall + 1;

  const slow = call(manager, "g2", "slow", { ms: 10_000 }, "control-v1").catch(
    (error: unknown) => error,
  );

  await call(manager, "g2", "ping", {}, "control-v1");

  expect(
    manager.cancel({
      type: "plugin.host.cancel",
      pluginId: "leased-fixture",
      generation: "g2",
      callId: `call-${id}`,
    }),
  ).toEqual({ cancelled: true });
  await expect(slow).resolves.toMatchObject({
    message: expect.stringContaining("cancelled"),
  });
});

it("requires explicit retained-worker permission to dispose across generations", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });
  await manager.reconcileGenerations([
    { pluginId: "leased-fixture", generation: "g2" },
  ]);

  const dispose = {
    type: "plugin.host.dispose" as const,
    pluginId: "leased-fixture",
    generation: "stale",
  };

  await expect(
    manager.dispose({ ...dispose, ...{ includeRetained: false } }),
  ).resolves.toEqual({
    disposed: false,
  });
  expect(alive(first)).toBe(true);
  await expect(
    manager.dispose({ ...dispose, ...{ includeRetained: true } }),
  ).resolves.toEqual({
    disposed: false,
  });
  expect(alive(first)).toBe(true);
  await expect(
    manager.dispose({ ...dispose, generation: "g2", includeRetained: true }),
  ).resolves.toEqual({ disposed: true });
  expect(alive(first)).toBe(false);
});

it("refuses a retired disposer after a new worker owns retained work", async () => {
  const manager = await createManager();
  await call(manager, "g1", "ping", {});
  const current = await call(manager, "g2", "hold", { releaseAfterMs: null });

  await expect(
    manager.dispose({
      type: "plugin.host.dispose",
      pluginId: "leased-fixture",
      generation: "g1",
      includeRetained: true,
    }),
  ).resolves.toEqual({ disposed: false });
  expect(alive(current)).toBe(true);
});

it("retires forwarded generations before a replacement worker owns work", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });
  await expect(call(manager, "g2", "ping", {}, "control-v1")).resolves.toBe(
    first,
  );
  await expect(call(manager, "g3", "ping", {}, "control-v1")).resolves.toBe(
    first,
  );
  await call(manager, "g3", "cancelJob", {}, "control-v1");
  const current = await call(manager, "g3", "hold", { releaseAfterMs: null });
  expect(current).not.toBe(first);

  await expect(
    manager.dispose({
      type: "plugin.host.dispose",
      pluginId: "leased-fixture",
      generation: "g2",
      includeRetained: true,
    }),
  ).resolves.toEqual({ disposed: false });
  await expect(call(manager, "g2", "ping", {}, "control-v1")).rejects.toThrow(
    "retired",
  );
  expect(alive(current)).toBe(true);
});

it("disposes retained work before the first replacement-generation call", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });

  await expect(
    manager.dispose({
      type: "plugin.host.dispose",
      pluginId: "leased-fixture",
      generation: "g2",
      includeRetained: true,
    }),
  ).resolves.toEqual({ disposed: true });
  expect(alive(first)).toBe(false);
});

it("defers a leased worker on reconnect only while its plugin stays active with another generation", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });

  await manager.reconcileGenerations([
    { pluginId: "leased-fixture", generation: "g2" },
  ]);
  expect(alive(first)).toBe(true);
  await expect(call(manager, "g2", "ping", {})).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });

  await manager.reconcileGenerations([]);
  expect(alive(first)).toBe(false);
});

it("stops a leased worker immediately when it is disposed", async () => {
  const manager = await createManager();
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });

  await expect(
    manager.dispose({
      type: "plugin.host.dispose",
      includeRetained: false,
      pluginId: "leased-fixture",
      generation: "g1",
    }),
  ).resolves.toEqual({ disposed: true });
  expect(alive(first)).toBe(false);
});

it("stops a leased worker that outlives the replacement limit", async () => {
  const manager = await createManager(400);
  const first = await call(manager, "g1", "hold", { releaseAfterMs: null });

  await expect(call(manager, "g2", "ping", {})).rejects.toMatchObject({
    code: PLUGIN_HOST_REPLACING_ERROR_CODE,
  });

  const second = await eventually(() => call(manager, "g2", "ping", {}));

  expect(second).not.toBe(first);
  expect(alive(first)).toBe(false);
});
