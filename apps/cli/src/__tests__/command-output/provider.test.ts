import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogPayloads,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerProviderCommands } from "../../commands/provider.js";

describe("omnyo provider command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerProviderCommands(program, () => "http://server");

  it("uses the shared owner profile endpoint for a project default", async () => {
    const post = vi.fn(async () => ({
      action: "defaultsSet",
      defaultSelection: { kind: "unprofiled" },
    }));

    stubServerApi({
      "v1.system.providers.claude-profiles.$post": post,
      "v1.hosts.$get": vi.fn(async () => [
        { id: "host-1", name: "Mac", status: "connected" },
      ]),
    });
    await runCommand(
      [
        "provider",
        "claude-profile",
        "default",
        "unprofiled",
        "--machine",
        "host-1",
        "--project",
        "proj-1",
        "--json",
      ],
      register,
    );
    expect(post).toHaveBeenCalledWith({
      json: {
        action: "defaultsSet",
        hostId: "host-1",
        projectId: "proj-1",
        selection: { kind: "unprofiled" },
      },
    });
  });

  it("omnyo provider list renders the shared borderless table", async () => {
    const get = vi.fn(async () => [{ id: "openai", displayName: "OpenAI" }]);
    stubServerApi({ "v1.system.providers.$get": get });

    await runCommand(["provider", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "ID      Name  \n------  ------\nopenai  OpenAI",
      "",
    ]);
  });

  it("omnyo provider list resolves a machine and preserves portable JSON output", async () => {
    const getProviders = vi.fn(async () => [
      { id: "acp-remote", displayName: "Remote ACP" },
    ]);

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          status: "connected",
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          runtimeVersion: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.system.providers.$get": getProviders,
    });

    await runCommand(
      ["provider", "list", "--machine", "builder", "--json"],
      register,
    );

    expect(getProviders).toHaveBeenCalledWith({
      query: { hostId: "host-remote" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        [{ id: "acp-remote", displayName: "Remote ACP" }],
        null,
        2,
      ),
    ]);
  });

  it("omnyo provider models includes a matching selected-only model", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [
        {
          model: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [
        {
          model: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          isDefault: false,
        },
      ],
      modelLoadError: null,
    }));

    stubServerApi({ "v1.system.execution-options.$get": get });

    await runCommand(
      [
        "provider",
        "models",
        "claude-code",
        "--selected-model",
        "claude-opus-4-6",
      ],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: {
        providerId: "claude-code",
        selectedModel: "claude-opus-4-6",
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Models for claude-code:",
      "",
      "Model             Name              Default\n----------------  ----------------  -------\nclaude-opus-4-6   Claude Opus 4.6\n----------------  ----------------  -------\nclaude-haiku-4-5  Claude Haiku 4.5  *",
      "",
    ]);
  });

  it("omnyo provider models routes through an environment", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [],
      selectedOnlyModels: [],
      modelLoadError: null,
    }));

    stubServerApi({ "v1.system.execution-options.$get": get });

    await runCommand(
      ["provider", "models", "codex", "--environment", "env-remote", "--json"],
      register,
    );

    expect(get).toHaveBeenCalledWith({
      query: { environmentId: "env-remote", providerId: "codex" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual(["[]"]);
  });

  it("omnyo provider models reports a model-load failure and its detail on stderr", async () => {
    const get = vi.fn(async () => ({
      providers: [],
      models: [],
      selectedOnlyModels: [],
      modelLoadError: {
        providerId: "codex",
        code: "failed",
        detail: "Omnyo could not find the Codex CLI on this machine.",
      },
    }));

    stubServerApi({ "v1.system.execution-options.$get": get });

    await runCommand(["provider", "models", "codex"], register);

    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["Could not load models for codex (failed)"],
      ["  Omnyo could not find the Codex CLI on this machine."],
    ]);
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "No models available",
    ]);
  });

  it("omnyo provider models prints the account notice on stderr until it expires", async () => {
    const notice = (until: number | null) => ({
      providers: [],
      models: [],
      selectedOnlyModels: [],
      modelLoadError: null,
      modelNotice: {
        providerId: "codex",
        message: "OpenAI used up",
        detail: "Showing openai2@",
        until,
      },
    });

    stubServerApi({
      "v1.system.execution-options.$get": vi.fn(async () => notice(null)),
    });
    await runCommand(["provider", "models", "codex"], register);

    expect(vi.mocked(console.error).mock.calls).toEqual([
      ["OpenAI used up · Showing openai2@"],
    ]);

    vi.mocked(console.error).mockClear();
    stubServerApi({
      "v1.system.execution-options.$get": vi.fn(async () =>
        notice(Date.now() + 2 * 60 * 60 * 1000),
      ),
    });
    await runCommand(["provider", "models", "codex"], register);

    const [line] = vi.mocked(console.error).mock.calls.map(([text]) => text);
    expect(line).toMatch(/^OpenAI used up until .+ · Showing openai2@$/u);

    vi.mocked(console.error).mockClear();
    stubServerApi({
      "v1.system.execution-options.$get": vi.fn(async () =>
        notice(Date.now() - 1000),
      ),
    });
    await runCommand(["provider", "models", "codex"], register);

    expect(vi.mocked(console.error).mock.calls).toEqual([]);
  });

  it("rejects simultaneous machine and environment selectors", async () => {
    await expect(
      runCommand(
        [
          "provider",
          "list",
          "--host",
          "builder",
          "--environment",
          "env-remote",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      "Error: Cannot combine --machine or --host with --environment; the environment already selects its machine.",
    );
  });
});
