import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClaudeProviderHealth,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";

const state = vi.hoisted(() => ({
  stdout: "",
  code: 0,
  spawn: vi.fn(),
  readFile: vi.fn(),
  resolveExecutablePath: vi.fn(),
  query: vi.fn(),
  readUsage: vi.fn(),
  accountInfo: vi.fn(),
  close: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ default: { readFile: state.readFile } }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: state.query }));

vi.mock("@omnyo/plugin-sdk/provider-bridge", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@omnyo/plugin-sdk/provider-bridge")
  >()),
  experimental_readCliVersion: () => Promise.resolve("2.1.318"),
  experimental_resolveExecutablePath: state.resolveExecutablePath,
  experimental_spawnPortableProcess: state.spawn,
}));

const network = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", network);
  state.stdout = JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "claude@example.com",
    subscriptionType: "pro",
  });
  state.code = 0;
  state.resolveExecutablePath.mockResolvedValue("/test/claude");
  state.query.mockReturnValue({
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: state.readUsage,
    accountInfo: state.accountInfo,
    close: state.close,
  });
  state.accountInfo.mockResolvedValue({ email: "claude@example.com" });
  state.readUsage.mockResolvedValue({
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 31.2, resets_at: "2026-11-30T00:00:00Z" },
    },
  });
  state.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
    });

    queueMicrotask(() => {
      child.stdout.end(state.stdout);
      child.emit("close", state.code);
    });

    return child;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Claude Code authentication and usage", () => {
  const profileEnv = {
    OMNYO_CLAUDE_CODE_EXECUTABLE: "/test/claude",
    CLAUDE_CONFIG_DIR: "/test/profile",
    ANTHROPIC_CONFIG_DIR: "/test/empty-platform",
  };

  it("reads usage in the selected native profile without starting a chat", async () => {
    expect(await getClaudeProviderUsage(profileEnv)).toEqual({
      supported: true,
      profileScoped: true,
      usage: {
        status: "ok",
        accountEmail: "claude@example.com",
        planLabel: "Pro",
        windows: [
          { label: "7D", usedPercent: 31.2, resetsAt: "2026-11-30T00:00:00Z" },
        ],
      },
    });
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining(profileEnv),
          persistSession: false,
          tools: [],
        }),
      }),
    );
    expect(state.readUsage).toHaveBeenCalledExactlyOnceWith({
      skipBehaviors: true,
    });
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("does not show numbers from a different account", async () => {
    state.accountInfo.mockResolvedValue({ email: "different@example.com" });

    const result = await getClaudeProviderUsage(profileEnv);

    expect(result).toMatchObject({
      usage: { status: "error", accountEmail: "claude@example.com" },
    });
    expect(result.usage).not.toHaveProperty("windows");
  });
  it("uses only Claude Code's auth status and omits unreported quota windows", async () => {
    expect(await getClaudeProviderUsage()).toEqual({
      supported: true,
      usage: {
        status: "error",
        message: "Run /usage in Claude Code to see your current limits.",
        accountEmail: "claude@example.com",
        planLabel: "Pro",
      },
    });
    expect(state.spawn).toHaveBeenCalledExactlyOnceWith({
      command: "claude",
      args: ["auth", "status"],
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(state.readFile).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("uses Claude Code's sign-in status for provider health", async () => {
    expect(await getClaudeProviderHealth()).toMatchObject({
      supported: true,
      health: {
        status: "ready",
        accountEmail: "claude@example.com",
        installedVersion: "2.1.318",
      },
    });
  });

  it("distinguishes logged-out status from a failed CLI probe", async () => {
    state.code = 1;
    state.stdout = '{"loggedIn":false,"authMethod":"none"}';

    expect(await getClaudeProviderUsage()).toMatchObject({
      usage: { status: "unauthenticated" },
    });

    state.stdout = "unrecognized output";

    expect(await getClaudeProviderUsage()).toMatchObject({
      usage: {
        status: "error",
        message: "Claude Code did not report its login status.",
      },
    });
    expect(await getClaudeProviderHealth()).toMatchObject({
      health: { status: "unknown" },
    });
  });

  it("reports the CLI's login expiration and handles an absent CLI", async () => {
    state.stdout = '{"loggedIn":true,"loginExpiresAt":"2020-01-01T00:00:00Z"}';

    expect(await getClaudeProviderUsage()).toMatchObject({
      usage: { status: "expired" },
    });

    state.resolveExecutablePath.mockResolvedValue(null);

    expect(await getClaudeProviderHealth()).toMatchObject({
      health: { status: "not_installed" },
    });
  });
});
