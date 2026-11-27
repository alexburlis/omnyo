import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { DynamicTool } from "@omnyo/domain";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAcpMcpServerConfig,
  type AcpMcpServerConfig,
} from "@omnyo/provider-bridge-protocol/acp/tool-proxy-mcp";

const here = dirname(fileURLToPath(import.meta.url));

const BRIDGE_MODULE = resolve(here, "bridge.ts");

const TSX_LOADER = import.meta.resolve("tsx");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function listenFakeBridge(args: {
  responseDelayMs: number | null;
  response?: unknown;
}): Promise<{
  port: number;
  server: Server;
  requests: unknown[];
  cancelled: unknown[];
  releaseResponses(): void;
}> {
  const requests: unknown[] = [];
  const cancelled: unknown[] = [];
  const sockets = new Set<Socket>();
  const heldResponses: Array<() => void> = [];
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");

      if (newline === -1) return;

      const request = JSON.parse(buffer.slice(0, newline)) as {
        kind?: unknown;
      };

      if (request.kind === "initialized") {
        socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);

        return;
      }

      requests.push(request);
      let responded = false;
      socket.once("close", () => {
        if (!responded) cancelled.push(request);
      });

      const response = args.response ?? {
        ok: true,
        content: '{"answers":{"Which?":"B"}}',
      };

      const respond = () => {
        responded = true;
        socket.end(`${JSON.stringify(response)}\n`);
      };

      if (args.responseDelayMs === null) {
        heldResponses.push(respond);
      } else {
        const timer = setTimeout(() => {
          responseTimers.delete(timer);
          respond();
        }, args.responseDelayMs);

        responseTimers.add(timer);
      }
    });
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        for (const timer of responseTimers) clearTimeout(timer);
        responseTimers.clear();
        heldResponses.length = 0;

        for (const socket of sockets) socket.destroy();
        server.close(() => resolveClose());
      }),
  );
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("fake bridge did not bind a port");
  }

  return {
    port: address.port,
    server,
    requests,
    cancelled,
    releaseResponses() {
      for (const respond of heldResponses.splice(0)) respond();
    },
  };
}

function testMcpConfig(
  port: number,
  tools?: DynamicTool[],
): AcpMcpServerConfig {
  return buildAcpMcpServerConfig({
    bridgeArgs: [
      "--conditions=source",
      "--import",
      TSX_LOADER,
      BRIDGE_MODULE,
      "--mcp-stdio",
    ],
    command: process.execPath,
    dynamicTools: tools ?? [
      {
        name: "AskUserQuestion",
        description: "Ask the user a question.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    host: "127.0.0.1",
    port,
    runtimeEnv: [],
    threadId: "thread-ask",
    token: "secret-token",
  });
}

function toolsFilePath(config: AcpMcpServerConfig): string {
  const path = config.env.find(
    ({ name }) => name === "OMNYO_ACP_DYNAMIC_TOOLS_FILE",
  )?.value;

  if (path === undefined) throw new Error("Missing tools file");

  return path;
}

async function connectLikeOpenCode(
  port: number,
  config = testMcpConfig(port),
): Promise<Client> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  for (const { name, value } of config.env) env[name] = value;
  env.OMNYO_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS = "200";

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "opencode-like", version: "0" });
  cleanups.push(() => client.close());
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[omnyo-bridge mcp] ${chunk.toString()}`);
  });

  return client;
}

describe("omnyo-bridge MCP catalog transport", () => {
  it("starts with a large catalog, survives failed spawn, and supports parallel children and reconnect", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 0 });

    const tools = Array.from({ length: 160 }, (_, index) => ({
      name: `large_tool_${index}`,
      description: "x".repeat(1_000),
      inputSchema: { type: "object", properties: {} },
    }));

    expect(Buffer.byteLength(JSON.stringify(tools))).toBeGreaterThan(131_072);
    const config = testMcpConfig(bridge.port, tools);
    const file = toolsFilePath(config);
    expect(
      config.env.some(({ name }) => name === "OMNYO_ACP_DYNAMIC_TOOLS"),
    ).toBe(false);
    await expect(
      connectLikeOpenCode(bridge.port, {
        ...config,
        command: `${process.execPath}-missing`,
      }),
    ).rejects.toThrow();

    const [first, parallel] = await Promise.all([
      connectLikeOpenCode(bridge.port, config),
      connectLikeOpenCode(bridge.port, config),
    ]);

    expect((await first.listTools()).tools).toEqual(tools);
    expect((await parallel.listTools()).tools).toEqual(tools);
    expect(
      (await first.callTool({ name: "large_tool_0", arguments: {} })).isError,
    ).toBeFalsy();
    await first.close();
    expect(existsSync(file)).toBe(true);
    expect(
      (await parallel.callTool({ name: "large_tool_159", arguments: {} }))
        .isError,
    ).toBeFalsy();
    const restarted = await connectLikeOpenCode(bridge.port, config);
    expect((await restarted.listTools()).tools).toEqual(tools);
  }, 20_000);

  it("stores only tool definitions in private catalog files and reuses identical catalogs", () => {
    const tools = [
      {
        name: "shared_tool",
        description: "Shared tool",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const config = testMcpConfig(1, tools);
    const file = toolsFilePath(config);
    const fileCount = readdirSync(dirname(file)).length;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(tools);

    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }

    expect(toolsFilePath(testMcpConfig(1, [...tools]))).toBe(file);
    expect(readdirSync(dirname(file))).toHaveLength(fileCount);
    expect(
      toolsFilePath(
        testMcpConfig(1, [{ ...tools[0], description: "Changed tool" }]),
      ),
    ).not.toBe(file);
  });

  it("removes its catalog directory when the launcher exits", () => {
    const module = import.meta
      .resolve("@omnyo/provider-bridge-protocol/acp/tool-proxy-mcp");

    const code = `
      import { buildAcpMcpServerConfig } from ${JSON.stringify(module)};
      const config = buildAcpMcpServerConfig({ command: process.execPath,
        bridgeArgs: [], dynamicTools: [], host: "127.0.0.1", port: 1,
        runtimeEnv: [], threadId: "cleanup-test", token: "test-token" });
      console.log(config.env.find(({ name }) => name === "OMNYO_ACP_DYNAMIC_TOOLS_FILE").value);
    `;

    const result = spawnSync(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        TSX_LOADER,
        "--input-type=module",
        "-e",
        code,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const file = result.stdout.trim();
    expect(file).toContain("omnyo-acp-tools-");
    expect(existsSync(dirname(file))).toBe(false);
  });

  it.each(["initialization", "write"])(
    "cleans up after a catalog %s failure and permits retry",
    (failure) => {
      const module = import.meta
        .resolve("@omnyo/provider-bridge-protocol/acp/tool-proxy-mcp");

      const code = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { buildAcpMcpServerConfig } from ${JSON.stringify(module)};
      const originalMkdtemp = fs.mkdtempSync;
      const originalWrite = fs.writeFileSync;
      const directories = [];
      fs.mkdtempSync = (...args) => {
        if (${JSON.stringify(failure)} === "initialization") throw new Error("synthetic initialization failure");
        const directory = originalMkdtemp(...args);
        directories.push(directory);
        return directory;
      };
      fs.writeFileSync = (path, ...args) => {
        originalWrite(path, "partial catalog", args[1]);
        throw new Error("synthetic write failure");
      };
      syncBuiltinESMExports();
      const args = { command: process.execPath, bridgeArgs: [], dynamicTools: [],
        host: "127.0.0.1", port: 1, runtimeEnv: [], threadId: "failure-test", token: "test-token" };
      let failed = false;
      try { buildAcpMcpServerConfig(args); } catch { failed = true; }
      const cleaned = directories.every((directory) => !fs.existsSync(directory));
      fs.mkdtempSync = originalMkdtemp;
      fs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
      const config = buildAcpMcpServerConfig(args);
      const file = config.env.find(({ name }) => name === "OMNYO_ACP_DYNAMIC_TOOLS_FILE").value;
      console.log(JSON.stringify({ failed, cleaned, tools: JSON.parse(fs.readFileSync(file, "utf8")), file }));
    `;

      const result = spawnSync(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          TSX_LOADER,
          "--input-type=module",
          "-e",
          code,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ failed: true, cleaned: true, tools: [] });
      expect(existsSync(dirname(report.file))).toBe(false);
    },
  );

  it("accepts the legacy inline catalog environment", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 0 });
    const config = testMcpConfig(bridge.port);
    const tools = JSON.parse(readFileSync(toolsFilePath(config), "utf8"));
    config.env = config.env.filter(
      ({ name }) => name !== "OMNYO_ACP_DYNAMIC_TOOLS_FILE",
    );
    config.env.push({
      name: "OMNYO_ACP_DYNAMIC_TOOLS",
      value: JSON.stringify(tools),
    });
    const client = await connectLikeOpenCode(bridge.port, config);
    expect((await client.listTools()).tools).toEqual(tools);
  }, 20_000);
});

describe("omnyo-bridge MCP server keeps long tool calls alive", () => {
  it("sends progress notifications so an OpenCode-style client does not time out while the user answers", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 2_500 });
    const client = await connectLikeOpenCode(fakeBridge.port);

    let progressCount = 0;

    const result = await client.callTool(
      {
        name: "AskUserQuestion",
        arguments: { questions: [] },
      },
      CallToolResultSchema,
      {
        timeout: 1_000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          progressCount += 1;
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: '{"answers":{"Which?":"B"}}' },
    ]);
    expect(progressCount).toBeGreaterThan(0);
    expect(fakeBridge.requests).toHaveLength(1);
  }, 20_000);

  it("relays an image-only result as an MCP image block", async () => {
    const fakeBridge = await listenFakeBridge({
      responseDelayMs: 0,
      response: {
        ok: true,
        content: "",
        contentBlocks: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });

    const client = await connectLikeOpenCode(fakeBridge.port);

    const result = await client.callTool(
      { name: "AskUserQuestion", arguments: {} },
      CallToolResultSchema,
      { timeout: 5_000 },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  }, 20_000);
});

describe("omnyo-bridge MCP cancellation", () => {
  it.each(["timeout", "abort", "disconnect"] as const)(
    "closes the bridge call on %s without a late MCP reply",
    async (kind) => {
      const bridge = await listenFakeBridge({ responseDelayMs: null });
      const client = await connectLikeOpenCode(bridge.port);
      const errors: string[] = [];
      client.onerror = (error) => errors.push(error.message);
      const controller = new AbortController();

      const result = client
        .callTool(
          { name: "AskUserQuestion", arguments: {} },
          CallToolResultSchema,
          {
            timeout: kind === "timeout" ? 200 : 5_000,
            signal: controller.signal,
          },
        )
        .catch((error) => error);

      await expect.poll(() => bridge.requests.length).toBe(1);

      if (kind === "abort") controller.abort();

      if (kind === "disconnect") await client.close();
      expect(await result).toBeInstanceOf(Error);
      await expect
        .poll(() => bridge.cancelled.length, { timeout: 1_000 })
        .toBe(1);
      bridge.releaseResponses();

      if (kind !== "disconnect") {
        expect((await client.listTools()).tools).toContainEqual(
          expect.objectContaining({ name: "AskUserQuestion" }),
        );
      }

      expect(
        errors.filter((error) => error.includes("unknown message ID")),
      ).toEqual([]);
    },
    20_000,
  );

  it("ignores unknown and malformed cancellations and preserves a normal answer", async () => {
    const bridge = await listenFakeBridge({ responseDelayMs: 300 });
    const client = await connectLikeOpenCode(bridge.port);
    const result = client.callTool({ name: "AskUserQuestion", arguments: {} });
    await expect.poll(() => bridge.requests.length).toBe(1);
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: "unrelated" },
    });
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: { invalid: true } },
    });
    expect((await result).isError).toBeFalsy();
    expect(bridge.cancelled).toHaveLength(0);
  }, 20_000);
});
