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
}));

vi.mock("node:fs/promises", () => ({ default: { readFile: state.readFile } }));

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
    email: "claude@example.com",
    subscriptionType: "pro",
  });
  state.code = 0;
  state.resolveExecutablePath.mockResolvedValue("/test/claude");
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
