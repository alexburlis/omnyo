import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@omnyo/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@omnyo/plugin-sdk/provider-bridge/testing";
import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";
import { stubFakeCodexAppServer } from "./fake-codex-app-server-harness.js";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;

let poolServer: Server | null = null;

const temporaryDirectories: string[] = [];

beforeEach(() => {
  stubFakeCodexAppServer();
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  experimental_killAllChildrenForTests();
  harness.restore();
  vi.unstubAllEnvs();
  const server = poolServer;
  poolServer = null;

  if (server !== null) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("reuses one initialized app-server across model catalog requests", async () => {
  harness.sendRequest(1, "model/list", {});
  const first = await harness.waitForResponse(1);
  harness.sendRequest(2, "model/list", {});
  const second = await harness.waitForResponse(2);

  expect(first.error).toBeUndefined();
  expect(second.error).toBeUndefined();
  expect(second.result).toEqual(first.result);
});

it.each([
  {
    name: "configured model",
    configRead: { config: { model: "configured-model" } },
    configReadError: false,
    expectedDefaults: [false, true],
  },
  {
    name: "unset model",
    configRead: { config: { model: null } },
    configReadError: false,
    expectedDefaults: [true, false],
  },
  {
    name: "model outside the catalog",
    configRead: { config: { model: "unlisted-model" } },
    configReadError: false,
    expectedDefaults: [true, false],
  },
  {
    name: "unavailable configuration API",
    configRead: { config: { model: "configured-model" } },
    configReadError: true,
    expectedDefaults: [true, false],
  },
  {
    name: "malformed configuration response",
    configRead: { config: { model: 42 } },
    configReadError: false,
    expectedDefaults: [true, false],
  },
])("resolves catalog defaults with $name", async (scenario) => {
  const workDir = await mkdtemp(join(tmpdir(), "omnyo-codex-model-default-"));
  temporaryDirectories.push(workDir);
  const scriptPath = join(workDir, "script.json");

  const catalog = [
    { id: "catalog-id", model: "catalog-model", isDefault: true },
    { id: "configured-id", model: "configured-model", isDefault: false },
  ];

  await writeFile(
    scriptPath,
    JSON.stringify({
      modelList: { data: catalog },
      configRead: scenario.configRead,
      configReadError: scenario.configReadError,
      turns: [],
    }),
  );
  stubFakeCodexAppServer(scriptPath);

  harness.sendRequest(1, "model/list", {});
  const response = await harness.waitForResponse(1);

  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({
    models: catalog.map((model, index) => ({
      id: model.id,
      model: model.model,
      isDefault: scenario.expectedDefaults[index],
    })),
    selectedOnlyModels: [],
  });
});

it("replaces the cached app-server after a model catalog failure", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "omnyo-codex-model-list-"));
  temporaryDirectories.push(workDir);
  const scriptPath = join(workDir, "script.json");
  await writeFile(
    scriptPath,
    JSON.stringify({
      modelListFailOnceMarkerPath: join(workDir, "failed-once"),
      turns: [],
    }),
  );
  stubFakeCodexAppServer(scriptPath);

  harness.sendRequest(1, "model/list", {});
  const failed = await harness.waitForResponse(1);
  harness.sendRequest(2, "model/list", {});
  const recovered = await harness.waitForResponse(2);

  expect(failed.error?.message).toContain(
    "Codex model/list returned no supported models.",
  );
  expect(recovered.error).toBeUndefined();
  expect(recovered.result).toMatchObject({
    models: [
      {
        displayName: "Fake model",
      },
    ],
  });
});

it("rejects a model catalog request with the missing-executable code when codex cannot be spawned", async () => {
  vi.stubEnv(
    "OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND",
    join(tmpdir(), "omnyo-codex-does-not-exist"),
  );
  vi.stubEnv("OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS", "[]");

  harness.sendRequest(1, "model/list", {});
  const response = await harness.waitForResponse(1);

  expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE);
  expect(response.error?.message).toContain("could not find the Codex CLI");
});

it("lists models through the Account Pooler when the request carries its environment", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "omnyo-codex-model-list-"));
  temporaryDirectories.push(workDir);
  const scriptPath = join(workDir, "script.json");
  const launchLogPath = join(workDir, "launches.ndjson");
  await writeFile(scriptPath, JSON.stringify({ launchLogPath, turns: [] }));
  stubFakeCodexAppServer(scriptPath);

  const requests: Array<{ path: string | undefined; authenticated: boolean }> =
    [];

  let poolStatus = 200;

  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      authenticated:
        request.headers["x-omnyo-account-pool-token"] === "pool-test-token",
    });
    response.writeHead(poolStatus, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        models: [
          {
            slug: "first-listed-model",
            display_name: "First Listed Model",
            priority: 1,
            visibility: "list",
          },
          {
            slug: "pooled-model",
            display_name: "Pooled Model",
            priority: 0,
            visibility: "list",
            supported_in_api: false,
            default_reasoning_level: "high",
            supported_reasoning_levels: [
              { effort: "high", description: "High" },
            ],
            service_tiers: [
              { id: "priority", name: "Fast", description: "Fast tier" },
            ],
          },
          {
            slug: "hidden-model",
            display_name: "Hidden Model",
            priority: -1,
            visibility: "hide",
          },
        ],
      }),
    );
  });

  poolServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected a loopback listening address");
  }

  const poolEnv = {
    CODEX_OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/api/v1/plugins/account-pool/http/v1`,
    CODEX_POOL_AUTH_TOKEN: "pool-test-token",
  };

  harness.sendRequest(1, "model/list", {});
  const signedIn = await harness.waitForResponse(1);
  harness.sendRequest(2, "model/list", { envVars: poolEnv });
  const pooled = await harness.waitForResponse(2);
  harness.sendRequest(3, "model/list", { envVars: poolEnv });
  const reused = await harness.waitForResponse(3);

  expect(signedIn.error).toBeUndefined();
  expect(pooled.error, pooled.error?.message).toBeUndefined();
  expect(reused.error).toBeUndefined();
  expect(signedIn.result).toMatchObject({
    models: [{ displayName: "Fake model" }],
  });
  expect(pooled.result).toMatchObject({
    models: [
      {
        id: "pooled-model",
        displayName: "Pooled Model",
        defaultReasoningEffort: "high",
        supportedServiceTiers: [{ id: "fast", label: "Fast" }],
        isDefault: true,
      },
      { id: "first-listed-model", isDefault: false },
    ],
    selectedOnlyModels: [],
  });
  expect(reused.result).toEqual(pooled.result);
  expect(requests).toEqual(
    Array.from({ length: 2 }, () => ({
      path: "/api/v1/plugins/account-pool/http/v1/models?client_version=0.169.0",
      authenticated: true,
    })),
  );

  const launches = (await readFile(launchLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[] });

  expect(launches).toHaveLength(2);
  expect(launches[0]?.args.join(" ")).not.toContain("omnyo-account-pool");
  expect(launches[1]?.args).toContain('model_provider="omnyo-account-pool"');
  expect(launches[1]?.args).toContain(
    `model_providers.omnyo-account-pool.base_url=${JSON.stringify(poolEnv.CODEX_OPENAI_BASE_URL)}`,
  );

  poolStatus = 503;
  harness.sendRequest(4, "model/list", { envVars: poolEnv });
  const failed = await harness.waitForResponse(4);

  expect(failed.error?.message).toContain("HTTP 503");
});
