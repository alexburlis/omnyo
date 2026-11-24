import type { PluginEventSourceDeclaration } from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  type ExperimentalFakeHostRpcCall,
} from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  vi.unstubAllGlobals();
});

const context = () => ({ signal: new AbortController().signal });

async function load(
  callHost: (call: ExperimentalFakeHostRpcCall) => unknown = () => {
    throw new Error("no host call expected");
  },
): Promise<ReadonlyMap<string, PluginEventSourceDeclaration>> {
  const host = createFakePluginHost({
    pluginId: "omnyo--wait-sources",
    sdk: {
      hosts: {
        get: async ({ hostId }) => {
          if (hostId === "host_gone")
            throw Object.assign(new Error("Host not found"), { status: 404 });

          return makeHostResponse({
            id: hostId,
            status: hostId === "host_asleep" ? "disconnected" : "connected",
          });
        },
      },
    },
    experimental_callHostRpc: callHost,
  });

  hosts.push(host);
  await plugin(host.api);

  return host.harness.registrations.eventSources;
}

function check(
  source: PluginEventSourceDeclaration | undefined,
  targets: string[],
) {
  if (source?.poll === null || source?.poll === undefined)
    throw new Error("expected a poll source");

  return source.poll.check(targets, context());
}

describe("wait sources", () => {
  it("registers http and command behind owner approval, file without", async () => {
    const sources = await load();

    expect(
      [...sources.values()].map((source) => [
        source.family,
        source.approval,
        source.poll?.everyMs,
      ]),
    ).toEqual([
      ["http", "owner", 60_000],
      ["file", "none", 60_000],
      ["command", "owner", 120_000],
    ]);
  });

  it("fires an http key on a 2xx answer that contains its text", async () => {
    const fetch = vi.fn(async (url: URL) => {
      if (url.hostname === "down.example.com")
        throw new TypeError("fetch failed");

      return url.pathname === "/busy"
        ? new Response("busy", { status: 503 })
        : new Response("build v0.47 is ready", { status: 200 });
    });

    vi.stubGlobal("fetch", fetch);

    const http = (await load()).get("http");

    await expect(
      check(http, [
        "https://ci.example.com/status#v0.47",
        "https://ci.example.com/status#v0.48",
        "https://ci.example.com/busy",
        "https://down.example.com/",
        "ftp://ci.example.com/",
      ]),
    ).resolves.toEqual([
      {
        target: "https://ci.example.com/status#v0.47",
        result:
          'https://ci.example.com/status answered 200 and contains "v0.47".',
      },
      {
        target: "ftp://ci.example.com/",
        problem: "expected an http or https URL",
      },
    ]);
    expect(http?.describe("https://ci.example.com/status#v0.47")).toBe(
      'ci.example.com/status shows "v0.47"',
    );
  });

  it("fires a file key once the path exists on a connected machine", async () => {
    const calls: ExperimentalFakeHostRpcCall[] = [];

    const file = (
      await load((call) => {
        calls.push(call);

        return call.input !== null &&
          typeof call.input === "object" &&
          Reflect.get(call.input, "path") === "/tmp/done"
          ? {
              exists: true,
              kind: "file",
              size: 4,
              modifiedAt: Date.UTC(2026, 9, 30),
            }
          : { exists: false, kind: null, size: null, modifiedAt: null };
      })
    ).get("file");

    await expect(
      check(file, [
        "host_1:/tmp/done",
        "host_1:/tmp/later",
        "host_asleep:/tmp/done",
        "host_gone:/tmp/done",
      ]),
    ).resolves.toEqual([
      {
        target: "host_1:/tmp/done",
        result:
          "/tmp/done exists on host_1 (file, 4 bytes, modified 2026-10-30T00:00:00.000Z).",
      },
      { target: "host_gone:/tmp/done", problem: "no machine host_gone" },
    ]);
    expect(calls.map((call) => [call.method, call.hostId])).toEqual([
      ["stat", "host_1"],
      ["stat", "host_1"],
    ]);
    expect(file?.describe("host_1:/Users/developer/build/out.zip")).toBe(
      "out.zip exists on host_1",
    );
  });

  it("fires a command key on exit 0 and reports a missing command", async () => {
    const command = (
      await load((call) => {
        const text =
          call.input !== null && typeof call.input === "object"
            ? Reflect.get(call.input, "command")
            : null;

        if (text === "deploy-done")
          return { exitCode: 0, stdout: "live\n", timedOut: false };

        if (text === "no-such-tool")
          return { exitCode: 127, stdout: "", timedOut: false };

        if (text === "explode") throw new Error("host worker exited");

        return { exitCode: 1, stdout: "", timedOut: false };
      })
    ).get("command");

    await expect(
      check(command, [
        "host_1:deploy-done",
        "host_1:not-yet",
        "host_1:no-such-tool",
        "host_1:explode",
      ]),
    ).resolves.toEqual([
      {
        target: "host_1:deploy-done",
        result: "`deploy-done` succeeded on host_1.\nlive",
      },
      {
        target: "host_1:no-such-tool",
        problem: "the command was not found (exit 127)",
      },
      {
        target: "host_1:explode",
        problem: "host_1 could not run it: host worker exited",
      },
    ]);
  });
});
