import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAiServiceRegistry } from "../ai/ai-service-registry.js";
import { createNoopTelemetryService } from "../system/telemetry.js";
import { testLogger } from "../../../test/helpers/test-app.js";
import { createPluginService } from "./plugin-service.js";
import type { LoadedPlugin } from "./plugin-service-internal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  setThreadStartupContext,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { makeThread } from "@omnyo/test-helpers/domain-fixtures";
import type { JsonValue } from "@omnyo/domain";
import {
  threadDispatchReadinessInputSchema,
  threadDispatchReadinessSchema,
} from "@omnyo/server-contract";
import type { PluginRpcHandler } from "./plugin-api.js";
import type { PluginService } from "./plugin-service.js";
import type { PluginAppBundleSnapshot } from "./app-bundle.js";
import {
  getPluginThreadBootstrapAssetUrls,
  readPluginThreadBootstrap,
} from "./plugin-thread-bootstrap.js";
import { openSecretVault } from "@omnyo/secret-storage";

let db: DbConnection;

let service: PluginService;

let fixtureDir: string;

let plugins: Map<string, LoadedPlugin>;

const thread = makeThread({ id: "thread-current", environmentId: null });

const malformedReadinessResults: JsonValue[] = [
  { action: "wait", reason: "" },
  { action: "reject", reason: "Do not run" },
  { action: "proceed", mutation: "unexpected" },
];

beforeEach(async () => {
  db = createConnection(":memory:");
  migrate(db);
  fixtureDir = await mkdtemp(join(tmpdir(), "omnyo-bootstrap-owners-"));
  service = createPluginService({
    db,
    dataDir: join(fixtureDir, "data"),
    vault: await openSecretVault(join(fixtureDir, "data")),
    appVersion: "0.9.0",
    bundledPlugins: [],
    aiServices: createAiServiceRegistry(),
    telemetry: createNoopTelemetryService(),
    logger: testLogger,
    hub: {
      getDaemonSessionIdForHost: () => null,
      notifyPluginSignal: () => 0,
      notifySystem: () => {},
    },
  });
  plugins = new Map([
    [
      "one",
      await loadedPlugin(
        "one",
        new Map([
          ["read", read],
          ["mutation", { ...read, threadBootstrap: false }],
        ]),
      ),
    ],
    ["two", await loadedPlugin("two", new Map([["read", read]]))],
  ]);
});

afterEach(async () => {
  await service.stop();
  db.$client.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

async function loadedPlugin(
  pluginId: string,
  handlers: ReadonlyMap<string, PluginRpcHandler>,
): Promise<LoadedPlugin> {
  const root = join(fixtureDir, pluginId);
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: `omnyo-plugin-${pluginId}`,
      version: "0.1.0",
      type: "module",
      omnyo: {
        name: pluginId,
        description: "Bootstrap fixture",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(root, "server.ts"),
    `
    import { z } from "zod";
    export default function plugin(api: any) {
      api.rpc.register({ seed: { input: z.null(), output: z.null() } }, { seed: () => null });
    }
  `,
  );
  const entry = await service.installPath(root);
  const lookup = service.getRpcHandler(entry.id, "seed");

  if (lookup.outcome !== "found") throw new Error("Fixture RPC owner missing");
  lookup.owner.handle.rpcHandlers.clear();

  for (const [method, handler] of handlers)
    lookup.owner.handle.rpcHandlers.set(method, handler);

  return lookup.owner;
}

const read: PluginRpcHandler = {
  publication: null,
  threadBootstrap: true,
  dispatchReadiness: false,
  inputSchema: z.object({ threadId: z.string() }),
  outputSchema: z.null(),
  handler: () => null,
};

describe("thread plugin bootstrap collection", () => {
  it("executes readiness reads with the pending thread's intended machine and validates their decision", async () => {
    const host = upsertHost(db, noopNotifier, { name: "Intended machine" });

    const { project } = createProject(db, noopNotifier, {
      name: "Fixture",
      source: { type: "local_path", hostId: host.id, path: "/fixture" },
    });

    const pending = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
      status: "pending",
    });

    setThreadStartupContext(db, {
      threadId: pending.id,
      startupContext: JSON.stringify({
        kind: "pending",
        environmentIntent: {
          type: "provider",
          environmentProviderId: "local",
          machine: { type: "existing", hostId: host.id },
          inputs: null,
        },
        fork: null,
        startedOnBehalfOf: null,
        titleProvided: true,
      }),
    });

    const handler = vi.fn((input: unknown) => {
      const context = threadDispatchReadinessInputSchema.parse(input);

      return context.host?.id === host.id
        ? { action: "wait", reason: "The intended machine is full" }
        : { action: "proceed" };
    });

    const readiness = {
      ...read,
      dispatchReadiness: true,
      inputSchema: threadDispatchReadinessInputSchema,
      outputSchema: threadDispatchReadinessSchema,
      handler,
    };

    const invoke: PluginService["invokeRpcHandler"] = async (
      owner,
      _method,
      record,
      input,
      caller,
      signal,
    ) => ({
      ok: true,
      result: threadDispatchReadinessSchema.parse(
        await record.handler(input, {
          experimental_caller: caller,
          experimental_signal: signal ?? owner.stopping.signal,
        }),
      ),
    });

    expect(
      await readPluginThreadBootstrap(
        { db },
        [
          [
            "capacity-policy",
            await loadedPlugin(
              "capacity-policy",
              new Map([["readiness", readiness]]),
            ),
          ],
        ],
        pending,
        invoke,
      ),
    ).toEqual([
      {
        pluginId: "capacity-policy",
        method: "readiness",
        dispatchReadiness: true,
        outcome: {
          ok: true,
          result: { action: "wait", reason: "The intended machine is full" },
        },
      },
    ]);
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      {
        thread: { id: pending.id, status: "pending" },
        host: { id: host.id, name: host.name },
      },
      {
        experimental_caller: { kind: "client" },
        experimental_signal: expect.any(AbortSignal),
      },
    );
  });

  it.each(malformedReadinessResults)(
    "keeps malformed readiness visible as an RPC error (%j)",
    async (result) => {
      const readiness = { ...read, dispatchReadiness: true };

      const invoke = vi.fn<PluginService["invokeRpcHandler"]>(async () => ({
        ok: true,
        result,
      }));

      expect(
        await readPluginThreadBootstrap(
          { db },
          [
            [
              "capacity-policy",
              await loadedPlugin(
                "capacity-policy",
                new Map([["readiness", readiness]]),
              ),
            ],
          ],
          thread,
          invoke,
        ),
      ).toMatchObject([
        {
          dispatchReadiness: true,
          outcome: { ok: false, error: { code: "invalid_output" } },
        },
      ]);
    },
  );

  it("starts opted-in reads together through the client RPC boundary with request cancellation", async () => {
    let finish:
      | ((
          result: Awaited<ReturnType<PluginService["invokeRpcHandler"]>>,
        ) => void)
      | undefined;

    const first = new Promise<
      Awaited<ReturnType<PluginService["invokeRpcHandler"]>>
    >((resolve) => {
      finish = resolve;
    });

    const invoke = vi.fn<PluginService["invokeRpcHandler"]>((owner) =>
      owner.pluginId === "one"
        ? first
        : Promise.resolve({
            ok: true,
            result: { headline: "Current outcome" },
          }),
    );

    const controller = new AbortController();

    const pending = readPluginThreadBootstrap(
      { db },
      plugins,
      thread,
      invoke,
      controller.signal,
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      plugins.get("one"),
      "read",
      read,
      { threadId: "thread-current" },
      { kind: "client" },
      controller.signal,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      plugins.get("two"),
      "read",
      read,
      { threadId: "thread-current" },
      { kind: "client" },
      controller.signal,
    );
    finish?.({ ok: true, result: null });
    expect(await pending).toEqual([
      { pluginId: "one", method: "read", outcome: { ok: true, result: null } },
      {
        pluginId: "two",
        method: "read",
        outcome: { ok: true, result: { headline: "Current outcome" } },
      },
    ]);
  });

  it("preserves visible RPC errors and returns no data when no plugins opted in", async () => {
    const invoke = vi.fn<PluginService["invokeRpcHandler"]>(async () => ({
      ok: false,
      error: { code: "handler_error", message: "Stored card unavailable" },
    }));

    expect(
      await readPluginThreadBootstrap({ db }, plugins, thread, invoke),
    ).toEqual([
      {
        pluginId: "one",
        method: "read",
        outcome: {
          ok: false,
          error: { code: "handler_error", message: "Stored card unavailable" },
        },
      },
      {
        pluginId: "two",
        method: "read",
        outcome: {
          ok: false,
          error: { code: "handler_error", message: "Stored card unavailable" },
        },
      },
    ]);
    invoke.mockClear();
    expect(await readPluginThreadBootstrap({ db }, [], thread, invoke)).toEqual(
      [],
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("thread bootstrap frontend hints", () => {
  it("selects only loaded compatible opted-in modules without invoking handlers and deduplicates URLs", () => {
    const handler = vi.fn(() => null);

    const optedIn = {
      handle: {
        rpcHandlers: new Map([
          ["read", { ...read, handler }],
          ["second", { ...read, handler }],
        ]),
      },
    };

    const loaded = new Map([
      ["one", optedIn],
      ["alias", optedIn],
      ["incompatible", optedIn],
      ["missing", optedIn],
      [
        "readiness-only",
        {
          handle: {
            rpcHandlers: new Map([
              ["readiness", { ...read, dispatchReadiness: true }],
            ]),
          },
        },
      ],
      [
        "ordinary",
        {
          handle: {
            rpcHandlers: new Map([
              ["read", { ...read, threadBootstrap: false, handler }],
            ]),
          },
        },
      ],
    ]);

    const snapshot: PluginAppBundleSnapshot = {
      state: {
        hasApp: true,
        bundle: {
          jsUrl: "/api/v1/plugin-app-assets/abcdef1234567890/app.js",
          cssUrl: null,
          jsBytes: 42,
          hash: "abcdef1234567890",
          sdkMajor: 0,
          sdkVersion: "0.6.42",
          compatible: true,
        },
      },
      assets: {
        jsPath: "/owned/dist/app.js",
        cssPath: null,
        hash: "abcdef1234567890",
      },
    };

    const bundles = new Map([
      ["one", snapshot],
      ["alias", snapshot],
      ["ordinary", snapshot],
      ["unloaded", snapshot],
      [
        "readiness-only",
        {
          ...snapshot,
          state: {
            ...snapshot.state,
            bundle: snapshot.state.bundle && {
              ...snapshot.state.bundle,
              jsUrl: "/readiness-settings.js",
            },
          },
        },
      ],
      [
        "incompatible",
        {
          ...snapshot,
          state: {
            ...snapshot.state,
            bundle: snapshot.state.bundle && {
              ...snapshot.state.bundle,
              compatible: false,
            },
          },
        },
      ],
      ["missing", { state: { hasApp: false, bundle: null }, assets: null }],
    ]);

    expect(getPluginThreadBootstrapAssetUrls(loaded, bundles)).toEqual([
      "/api/v1/plugin-app-assets/abcdef1234567890/app.js",
    ]);
    expect(handler).not.toHaveBeenCalled();
  });
});
