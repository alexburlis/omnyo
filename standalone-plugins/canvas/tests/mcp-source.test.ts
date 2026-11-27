import { sourceMigrations } from "../lib/storage.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { sourceInputSchema, type SourceInput, type SourceJson } from "../source-contract";
import {
  SourceError,
  SourceService,
  isMcpAddress,
  loadSource,
  parseMcpOrigins,
  type LoadedSource,
  type SourceAccess,
  type SourceLoader,
  type SourceRequest,
  type SourceTransport,
} from "../lib/sources";

const origin = "https://status.example.net:9443";

const access: SourceAccess = {
  gscBroker: "",
  posthogOrigin: "https://eu.posthog.com",
  mcpOrigins: [origin],
};

const overview = {
  apps: [
    { app: "web", deployment: { state: "live" } },
    { app: "api", deployment: { state: "rolling" } },
  ],
};

const readTool = { name: "overview", annotations: { readOnlyHint: true } };

interface Message {
  id?: number;
  method: string;
  params?: { cursor?: string; name?: string; arguments?: SourceJson; protocolVersion?: string };
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string[];
}

interface Options {
  tools?: SourceJson[][];
  result?: SourceJson;
  sse?: boolean;
  session?: string;
  error?: { code: number; message: string };
}

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function mcpSource(
  config: Record<string, SourceJson> = {},
): Extract<SourceInput, { provider: "mcp" }> {
  const result = sourceInputSchema.parse({
    id: "deploys",
    title: "Deploys",
    provider: "mcp",
    config: {
      url: `${origin}/mcp`,
      tool: "overview",
      rowsPath: ["apps"],
      columns: [
        { key: "app", label: "App", type: "string" },
        { key: "state", label: "State", type: "string", path: ["deployment", "state"] },
      ],
      ...config,
    },
  });

  if (result.provider !== "mcp") throw new Error("Expected MCP source");

  return result;
}

function respond(payload: SourceJson, options: Options): Reply {
  return options.sse
    ? {
        headers: { "content-type": "text/event-stream" },
        body: [
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n',
          ...`event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`.match(/.{1,7}/gsu)!,
        ],
      }
    : { headers: { "content-type": "application/json" }, body: [JSON.stringify(payload)] };
}

function mcpServer(options: Options = {}) {
  const pages = options.tools ?? [[readTool]];

  return (message: Message): Reply => {
    const answer = (result: SourceJson) =>
      respond(
        options.error && message.method === "tools/call"
          ? { jsonrpc: "2.0", id: message.id ?? null, error: options.error }
          : { jsonrpc: "2.0", id: message.id ?? null, result },
        options,
      );

    switch (message.method) {
      case "initialize": {
        const reply = answer({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "status", version: "1" },
        });

        return options.session
          ? { ...reply, headers: { ...reply.headers, "mcp-session-id": options.session } }
          : reply;
      }

      case "notifications/initialized":
        return { status: 202, headers: {} };
      case "tools/list": {
        const index = message.params?.cursor ? Number(message.params.cursor) : 0;

        const tools = pages[index] ?? [];

        return answer(
          index + 1 < pages.length ? { tools, nextCursor: String(index + 1) } : { tools },
        );
      }

      case "tools/call":
        return answer(options.result ?? { content: [], structuredContent: overview });
      default:
        return { status: 400 };
    }
  };
}

function transportFor(handle: (message: Message) => Reply, address = "100.101.102.103") {
  const calls: Array<{ url: string; request: SourceRequest; message: Message }> = [];

  const transport: SourceTransport = {
    lookup: vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]),
    request: vi.fn(async (url: URL, request: SourceRequest) => {
      const message: Message = JSON.parse(request.body ?? "null");
      calls.push({ url: url.href, request, message });
      const reply = handle(message);
      const chunks = reply.body ?? [];

      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? { "content-type": "application/json" },
        body: (async function* () {
          for (const chunk of chunks) yield Buffer.from(chunk);
        })(),
        discard() {},
      };
    }),
  };

  return { transport, calls };
}

function load(
  definition: SourceInput,
  transport: SourceTransport,
  options: { authorization?: string; access?: SourceAccess } = {},
) {
  return loadSource(
    definition,
    options.authorization ?? null,
    undefined,
    options.access ?? access,
    undefined,
    transport,
  );
}

const expectedRows = [
  { app: "web", state: "live" },
  { app: "api", state: "rolling" },
];

describe("MCP source configuration", () => {
  it("validates the tool, arguments and polling interval", () => {
    const parsed = mcpSource();
    expect(parsed.config.arguments).toEqual({});
    expect(parsed.intervalSeconds).toBe(0);
    const nested = { app: "web", limit: 3, tags: ["a", "b"], filter: { region: "eu", ids: [1] } };
    expect(mcpSource({ arguments: nested }).config.arguments).toEqual(nested);

    const base = {
      id: "deploys",
      title: "Deploys",
      provider: "mcp",
      config: {
        url: `${origin}/mcp`,
        tool: "overview",
        columns: [{ key: "app", label: "App", type: "string" }],
      },
    };

    expect(sourceInputSchema.safeParse({ ...base, intervalSeconds: 60 }).success).toBe(true);
    expect(sourceInputSchema.safeParse({ ...base, intervalSeconds: 30 }).success).toBe(false);

    for (const config of [
      { tool: "bad tool" },
      { tool: "x".repeat(65) },
      { tool: "" },
      { arguments: ["not", "an", "object"] },
      { arguments: { blob: "x".repeat(4100) } },
      { arguments: { filter: { nested: { deeper: true } } } },
      { unexpected: true },
      { url: "not a url" },
      { columns: [] },
    ])
      expect(
        sourceInputSchema.safeParse({ ...base, config: { ...base.config, ...config } }).success,
      ).toBe(false);
  });

  it("parses the owner allowlist as exact HTTPS origins", () => {
    expect(parseMcpOrigins("")).toEqual([]);
    expect(parseMcpOrigins(` ${origin}\nhttps://other.example.com, `)).toEqual([
      origin,
      "https://other.example.com",
    ]);

    for (const value of [
      "http://status.example.net",
      "https://status.example.net/mcp",
      "https://user@status.example.net",
      "status.example.net",
    ])
      expect(() => parseMcpOrigins(value)).toThrow(SourceError);
  });
});

describe("MCP source network policy", () => {
  it("refuses servers that the owner has not listed before any network I/O", async () => {
    const { transport } = transportFor(mcpServer());

    await expect(
      load(mcpSource(), transport, { access: { ...access, mcpOrigins: [] } }),
    ).rejects.toThrow("MCP sources are off until the owner lists the server origin");
    await expect(
      load(mcpSource({ url: "https://status.example.net/mcp" }), transport),
    ).rejects.toThrow("is not listed");
    await expect(
      load(mcpSource({ url: "http://status.example.net:9443/mcp" }), transport),
    ).rejects.toThrow(SourceError);
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("allows private and carrier-grade NAT addresses only for listed MCP origins", async () => {
    const { transport, calls } = transportFor(mcpServer());
    await expect(load(mcpSource(), transport)).resolves.toMatchObject({ rows: expectedRows });
    expect(calls.every((call) => call.request.address.address === "100.101.102.103")).toBe(true);
    expect(transport.lookup).toHaveBeenCalledOnce();
    expect(transport.lookup).toHaveBeenCalledWith("status.example.net");

    const json = sourceInputSchema.parse({
      id: "public",
      title: "Public",
      provider: "json",
      config: {
        url: "https://status.example.net/data",
        columns: [{ key: "app", label: "App", type: "string" }],
      },
    });

    const publicOnly = transportFor(() => ({ body: ["[]"] }));
    await expect(load(json, publicOnly.transport)).rejects.toThrow(
      "Source URLs must resolve only to public network addresses",
    );
    expect(publicOnly.transport.request).not.toHaveBeenCalled();

    for (const address of ["10.0.0.5", "192.168.1.4", "100.64.0.1", "fd7a:115c:a1e0::1", "1.1.1.1"])
      expect(isMcpAddress(address)).toBe(true);
  });

  it("refuses loopback, link-local and metadata addresses even for listed origins", async () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "fe80::1",
      "224.0.0.1",
      "100.100.100.200",
      "fd00:ec2::254",
      "not-an-address",
    ])
      expect(isMcpAddress(address)).toBe(false);

    const { transport } = transportFor(mcpServer(), "127.0.0.1");
    await expect(load(mcpSource(), transport)).rejects.toThrow(
      "MCP servers must not resolve to loopback",
    );
    expect(transport.request).not.toHaveBeenCalled();
  });
});

describe("MCP source protocol", () => {
  it("initializes, lists the tool and maps structured JSON responses through rowsPath", async () => {
    const { transport, calls } = transportFor(mcpServer());

    await expect(
      load(mcpSource({ arguments: { scope: "all" } }), transport, {
        authorization: "Bearer synthetic-test-credential",
      }),
    ).resolves.toEqual({
      columns: [
        { key: "app", label: "App", type: "string" },
        { key: "state", label: "State", type: "string" },
      ],
      rows: expectedRows,
    });

    expect(calls.map((call) => call.message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(calls.every((call) => call.url === `${origin}/mcp`)).toBe(true);
    expect(calls.every((call) => call.request.method === "POST")).toBe(true);
    expect(calls[0]?.message.params).toMatchObject({
      protocolVersion: "2025-06-18",
      clientInfo: { name: "omnyo-canvas" },
    });
    expect(calls[3]?.message.params).toEqual({ name: "overview", arguments: { scope: "all" } });

    for (const call of calls)
      expect(call.request.headers).toMatchObject({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-test-credential",
      });
    expect(calls[0]?.request.headers["MCP-Protocol-Version"]).toBeUndefined();

    for (const call of calls.slice(1))
      expect(call.request.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(calls.some((call) => "Mcp-Session-Id" in call.request.headers)).toBe(false);
  });

  it("reads event-stream responses and sends the session ID on later requests", async () => {
    const { transport, calls } = transportFor(mcpServer({ sse: true, session: "session-1a2b" }));
    await expect(load(mcpSource(), transport)).resolves.toMatchObject({ rows: expectedRows });
    expect(calls[0]?.request.headers["Mcp-Session-Id"]).toBeUndefined();

    for (const call of calls.slice(1))
      expect(call.request.headers["Mcp-Session-Id"]).toBe("session-1a2b");
  });

  it("follows tool list pages to find the configured tool", async () => {
    const { transport, calls } = transportFor(
      mcpServer({
        tools: [[{ name: "deploy", annotations: { readOnlyHint: false } }], [readTool]],
      }),
    );

    await expect(load(mcpSource(), transport)).resolves.toMatchObject({ rows: expectedRows });
    expect(calls.filter((call) => call.message.method === "tools/list").length).toBe(2);
    expect(calls[3]?.message.params).toEqual({ cursor: "1" });
  });

  it("refuses tools that the server does not mark read-only", async () => {
    const unmarked: SourceJson[] = [
      { name: "overview" },
      { name: "overview", annotations: {} },
      { name: "overview", annotations: { readOnlyHint: false } },
    ];

    for (const tool of unmarked) {
      const { transport, calls } = transportFor(mcpServer({ tools: [[tool]] }));
      await expect(load(mcpSource(), transport)).rejects.toThrow(
        "MCP tool is not marked read-only",
      );
      expect(calls.some((call) => call.message.method === "tools/call")).toBe(false);
    }

    const { transport } = transportFor(mcpServer({ tools: [[{ ...readTool, name: "other" }]] }));
    await expect(load(mcpSource(), transport)).rejects.toThrow(
      'MCP server does not list the tool "overview"',
    );
  });

  it("reports tool errors with a short first text block", async () => {
    const { transport } = transportFor(
      mcpServer({
        result: {
          isError: true,
          content: [{ type: "text", text: `App is unavailable\u0007 ${"x".repeat(400)}` }],
        },
      }),
    );

    const failure = await load(mcpSource(), transport).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(SourceError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("MCP tool reported an error: App is unavailable");
    expect(message).not.toContain("\u0007");
    expect(message.length).toBeLessThanOrEqual(240);
  });

  it("prefers structured content and falls back to the first JSON text block", async () => {
    const both = transportFor(
      mcpServer({
        result: {
          content: [{ type: "text", text: JSON.stringify({ apps: [] }) }],
          structuredContent: overview,
        },
      }),
    );

    await expect(load(mcpSource(), both.transport)).resolves.toMatchObject({ rows: expectedRows });

    const text = transportFor(
      mcpServer({
        result: {
          content: [
            { type: "image", data: "", mimeType: "image/png" },
            { type: "text", text: JSON.stringify(overview) },
          ],
        },
      }),
    );

    await expect(load(mcpSource(), text.transport)).resolves.toMatchObject({ rows: expectedRows });

    const prose = transportFor(
      mcpServer({ result: { content: [{ type: "text", text: "All apps are live" }] } }),
    );

    await expect(load(mcpSource(), prose.transport)).rejects.toThrow("MCP tool result is not JSON");
  });

  it("turns JSON-RPC and HTTP failures into short source errors", async () => {
    const rpc = transportFor(
      mcpServer({ error: { code: -32602, message: "Unknown app\nprivate-provider-diagnostic" } }),
    );

    await expect(load(mcpSource(), rpc.transport)).rejects.toThrow(
      "MCP server error: Unknown app private-provider-diagnostic",
    );

    const http = transportFor(() => ({ status: 403, body: ["Forbidden"] }));
    await expect(load(mcpSource(), http.transport)).rejects.toThrow(
      "MCP server returned HTTP 403; redirects are not followed",
    );

    const silent = transportFor((message) =>
      message.method === "initialize"
        ? { headers: { "content-type": "text/event-stream" }, body: [": keep-alive\n\n"] }
        : { status: 202 },
    );

    await expect(load(mcpSource(), silent.transport)).rejects.toThrow(
      "MCP server sent no response",
    );
  });
});

describe("MCP sources in the source service", () => {
  function fixture(loader: SourceLoader) {
    const host = createFakePluginHost({ pluginId: "canvas" });
    hosts.push(host);
    host.api.storage.migrate(host.api.storage.database(), sourceMigrations);
    host.api.storage
      .database()
      .exec(
        "CREATE TABLE canvas_threads(thread_id TEXT PRIMARY KEY,enabled INTEGER); INSERT INTO canvas_threads VALUES('thread',1);",
      );

    return { host, sources: new SourceService(host.api, loader) };
  }

  const loaded: LoadedSource = {
    columns: [{ key: "app", label: "App", type: "string" }],
    rows: [{ app: "web" }],
  };

  it("passes the parsed owner allowlist and an origin-bound credential to the loader", async () => {
    const loader = vi.fn<SourceLoader>(async () => loaded);
    const { sources, host } = fixture(loader);
    await host.harness.behavior.setSettings({
      mcpOrigins: `${origin}\nhttps://other.example.com`,
      apiOrigin1: origin,
      apiToken1: "synthetic-test-credential",
    });
    sources.upsert("thread", mcpSource({ credential: "apiToken1" }));
    const result = await sources.refresh("thread", "deploys");
    expect(result.source.status).toBe("ready");
    expect(loader).toHaveBeenCalledWith(
      expect.anything(),
      "Bearer synthetic-test-credential",
      expect.anything(),
      expect.objectContaining({ mcpOrigins: [origin, "https://other.example.com"] }),
    );
  });

  it("refuses credentials for another origin and plain HTTP MCP URLs", async () => {
    const loader = vi.fn<SourceLoader>(async () => loaded);
    const { sources, host } = fixture(loader);
    await host.harness.behavior.setSettings({
      mcpOrigins: origin,
      apiOrigin1: "https://status.example.net",
      apiToken1: "synthetic-test-credential",
    });
    sources.upsert("thread", mcpSource({ credential: "apiToken1" }));
    const result = await sources.refresh("thread", "deploys");
    expect(result.source.error).toContain("not approved");
    expect(loader).not.toHaveBeenCalled();
    expect(() =>
      sources.upsert("thread", mcpSource({ url: "http://status.example.net:9443/mcp" })),
    ).toThrow(SourceError);
  });
});
