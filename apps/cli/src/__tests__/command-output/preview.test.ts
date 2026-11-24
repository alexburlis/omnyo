import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerPreviewCommands } from "../../commands/preview.js";

const binding = {
  id: "preview-1",
  projectId: "project-1",
  threadId: "thread-1",
  environmentId: "environment-1",
  hostId: "host-1",
  hostName: "Mac Pro",
  url: "http://localhost:4399/compare?mode=1#section",
  remoteUrl: "http://server/previews/preview-1/compare?mode=1#section",
  createdAt: 1,
};

describe("omnyo preview command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerPreviewCommands(program, () => "http://server");

  it("records exact argv after -- without joining or running shell text", async () => {
    const save = vi.fn(async () => binding);
    stubServerApi({ "v1.previews.$post": save });

    await runCommand(
      [
        "preview",
        "register",
        "--thread",
        "thread-1",
        "--url",
        binding.url,
        "--cwd",
        "/project with spaces",
        "--readiness-path",
        "/compare?mode=1",
        "--json",
        "--",
        "/safe launcher",
        "--port",
        "4399",
        "$(literal)",
        "one;two",
      ],
      register,
    );

    expect(save).toHaveBeenCalledWith({
      json: {
        threadId: "thread-1",
        url: binding.url,
        cwd: "/project with spaces",
        readinessPath: "/compare?mode=1",
        argv: ["/safe launcher", "--port", "4399", "$(literal)", "one;two"],
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(binding, null, 2),
    ]);
  });

  it("keeps a supplied restart request identity and sends no launch recipe", async () => {
    const status = {
      state: "online",
      checkedAt: 1,
      detail: null,
      runId: "run-1",
    };

    const restart = vi.fn(async () => status);
    stubServerApi({ "v1.previews.:previewId.restart.$post": restart });

    await runCommand(
      ["preview", "restart", binding.id, "--request-id", "request-1", "--json"],
      register,
    );

    expect(restart).toHaveBeenCalledWith({
      param: { previewId: binding.id },
      json: { requestId: "request-1" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(status, null, 2),
    ]);
  });

  it("reports a foreign port conflict as one JSON error and exits nonzero", async () => {
    stubServerApi({
      "v1.previews.:previewId.restart.$post": async () => ({
        state: "conflict",
        checkedAt: 1,
        detail: "Port belongs to another process",
        runId: null,
      }),
    });

    await expect(
      runCommand(["preview", "restart", binding.id, "--json"], register),
    ).rejects.toThrow("process.exit:1");

    const output = collectLogPayloads(vi.mocked(console.log));
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({
      ok: false,
      error: {
        code: "preview_not_ready",
        message: "Preview is conflict: Port belongs to another process",
      },
    });
  });
});
