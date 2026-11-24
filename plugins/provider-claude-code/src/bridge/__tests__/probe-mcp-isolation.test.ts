import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { readIsolatedClaudeContextUsage } from "../context-usage-probe.js";
import { listClaudeCodeBridgeModels } from "../model-list.js";
import { OMNYO_BRIDGE_MCP_SERVER_NAME } from "../../tool-classification.js";

function probeOptions(): Options {
  const options = queryMock.mock.calls.at(-1)?.[0]?.options;

  if (options === undefined) throw new Error("Expected a Claude SDK query");

  return options;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockReturnValue({
    initializationResult: () =>
      Promise.resolve({
        models: [
          {
            value: "claude-sonnet-5",
            displayName: "Sonnet 5",
            description: "Fixture",
          },
        ],
      }),
    mcpServerStatus: () =>
      Promise.resolve([
        { name: OMNYO_BRIDGE_MCP_SERVER_NAME, status: "connected" },
      ]),
    getContextUsage: () => Promise.resolve({ totalTokens: 1 }),
    close: vi.fn(),
  });
});

describe("Claude metadata probes", () => {
  it("list models without loading user, project or plugin MCP servers", async () => {
    await listClaudeCodeBridgeModels({});

    expect(probeOptions()).toMatchObject({ strictMcpConfig: true });
    expect(probeOptions().mcpServers).toBeUndefined();
  });

  it("read context usage with only the Omnyo bridge MCP server", async () => {
    await readIsolatedClaudeContextUsage({
      sessionOptions: {
        cwd: "/tmp/probe",
        systemPrompt: "Fixture",
        allowBypassPermissions: false,
      },
      providerSessionId: "session-1",
      dynamicTools: [
        { name: "tool", description: "desc", inputSchema: { type: "object" } },
      ],
      signal: new AbortController().signal,
    });

    expect(probeOptions()).toMatchObject({ strictMcpConfig: true });
    expect(Object.keys(probeOptions().mcpServers ?? {})).toEqual([
      OMNYO_BRIDGE_MCP_SERVER_NAME,
    ]);
  });
});
