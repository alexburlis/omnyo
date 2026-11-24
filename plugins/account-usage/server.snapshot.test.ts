import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";
import { snapshotSchema } from "./contract.ts";
import type { AccountSummary } from "./lib/pool-contracts.ts";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

function createHost(options: Parameters<typeof createFakePluginHost>[0]) {
  const host = createFakePluginHost(options);
  hosts.push(host);

  return host;
}

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map(({ harness }) => harness.lifecycle.dispose()),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const account: AccountSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  kind: "oauth",
  enabled: true,
  label: null,
  email: null,
  subscriptionType: null,
  priority: 1,
  lastUsedAt: null,
  fiveHourUtilization: null,
  fiveHourResetAt: null,
  fiveHourStatus: null,
  sevenDayUtilization: 0.25,
  sevenDayResetAt: Date.now() + 3 * 86_400_000,
  sevenDayStatus: "allowed",
  familyWeekly: {},
  limitWindows: [],
  observedAt: 1793782800000,
  heldUntil: null,
  error: null,
  inFlight: 0,
  status: "ready",
};

const status = {
  accepting: true,
  inFlight: 0,
  enabledAccountCount: 0,
  routing: { claude: true, codex: true },
  accounts: [],
};

describe("usage snapshot failure visibility", () => {
  it("surfaces a failed configuration read instead of guessing the routing threshold", async () => {
    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: ({ method }) => {
            if (method === "status.get") return status;
            throw new Error("Pool configuration unavailable");
          },
        },
      },
    });

    plugin(api);
    await expect(harness.callRpc("snapshot", null)).resolves.toMatchObject({
      error: "Pool configuration unavailable",
      poolUnavailable: false,
      groups: [],
    });
  });

  it("retains the reading after a manual refresh fails without repeating the provider action", async () => {
    let refreshes = 0;

    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: ({ method }) => {
            if (method === "status.get")
              return {
                ...status,
                enabledAccountCount: 1,
                accounts: [{ ...account, provider: "codex" }],
              };

            if (method === "config.get") return { switchThreshold: 0.98 };
            refreshes += 1;
            throw new Error("Provider usage refresh unavailable");
          },
        },
      },
    });

    plugin(api);

    const previous = snapshotSchema.parse(
      await harness.callRpc("snapshot", null),
    );

    await expect(harness.callRpc("refresh", null)).resolves.toEqual({
      ...previous,
      error: "Provider usage refresh unavailable",
    });
    await harness.callRpc("snapshot", null);
    expect(refreshes).toBe(1);
  });

  it("rejects missing configuration fields instead of presenting default routing policy", async () => {
    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: ({ method, outputSchema }) =>
            outputSchema.parse(method === "status.get" ? status : {}),
        },
      },
    });

    plugin(api);
    const snapshot = await harness.callRpc("snapshot", null);
    expect(snapshot).toMatchObject({
      poolUnavailable: false,
      groups: [],
      error: expect.any(String),
    });
  });

  it.each([
    ["status.get", "fetch failed"],
    ["config.get", "fetch failed"],
    [
      "status.get",
      'HTTP 503: plugin "account-pool" is not running (status: running — another action is disabled)',
    ],
  ])(
    "keeps the last successful reading and its timestamp when %s fails with %s, then recovers",
    async (failedMethod, failureMessage) => {
      vi.useFakeTimers();
      vi.setSystemTime(1793782800000);
      let failing = false;
      let current = { ...status, enabledAccountCount: 1, accounts: [account] };

      const { api, harness } = createHost({
        pluginId: "omnyo--account-usage",
        sdk: {
          plugins: {
            callRpc: ({ method }) => {
              if (failing && method === failedMethod)
                throw new TypeError(failureMessage);

              return method === "status.get"
                ? current
                : { switchThreshold: 0.98 };
            },
          },
        },
      });

      plugin(api);

      const previous = snapshotSchema.parse(
        await harness.callRpc("snapshot", null),
      );

      expect(previous.groups[0]?.accounts[0]?.id).toBe(account.id);
      vi.setSystemTime(1793782830000);
      failing = true;
      await expect(harness.callRpc("snapshot", null)).resolves.toEqual({
        ...previous,
        error: failureMessage,
      });
      failing = false;
      current = {
        ...current,
        accounts: [{ ...account, sevenDayUtilization: 0.4 }],
      };

      const recovered = snapshotSchema.parse(
        await harness.callRpc("snapshot", null),
      );

      expect(recovered.error).toBeNull();
      expect(recovered.fetchedAt).toBe(1793782830000);
      expect(recovered.groups).not.toEqual(previous.groups);
    },
  );

  it.each([
    "HTTP 404: unknown plugin",
    "HTTP 503: plugin disabled",
    'HTTP 503: plugin "account-pool" is not running (status: disabled)',
  ])(
    "clears retained readings when the pool is authoritatively unavailable: %s",
    async (message) => {
      let failing = false;

      const { api, harness } = createHost({
        pluginId: "omnyo--account-usage",
        sdk: {
          plugins: {
            callRpc: ({ method }) => {
              if (failing && method === "status.get") throw new Error(message);

              return method === "status.get"
                ? { ...status, enabledAccountCount: 1, accounts: [account] }
                : { switchThreshold: 0.98 };
            },
          },
        },
      });

      plugin(api);
      await harness.callRpc("snapshot", null);
      failing = true;
      await expect(harness.callRpc("snapshot", null)).resolves.toMatchObject({
        error: null,
        poolUnavailable: true,
        groups: [],
      });
      failing = false;
      harness.sdk.stub("plugins.callRpc", () => {
        throw new TypeError("fetch failed");
      });
      await expect(harness.callRpc("snapshot", null)).resolves.toMatchObject({
        error: "fetch failed",
        poolUnavailable: false,
        groups: [],
      });
    },
  );

  it("shares an unfinished read across concurrent clients", async () => {
    let reads = 0;

    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: async ({ method }) => {
            if (method === "config.get") return { switchThreshold: 0.98 };
            reads += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));

            return status;
          },
        },
      },
    });

    plugin(api);

    const snapshots = await Promise.all([
      harness.callRpc("snapshot", null),
      harness.callRpc("snapshot", null),
    ]);

    expect(reads).toBe(1);
    expect(snapshots[0]).toEqual(snapshots[1]);
    await harness.callRpc("snapshot", null);
    expect(reads).toBe(2);
  });

  describe("on a busy machine", () => {
    function slowPool(statusDelayMs: number | null) {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException(
                "The operation was aborted due to timeout",
                "TimeoutError",
              ),
            ),
          ms,
        );

        return controller.signal;
      });

      const { api, harness } = createHost({
        pluginId: "omnyo--account-usage",
        sdk: {
          plugins: {
            callRpc: ({ method, signal }) => {
              if (method === "config.get") return { switchThreshold: 0.98 };

              return new Promise((resolve, reject) => {
                if (statusDelayMs !== null)
                  setTimeout(
                    () =>
                      resolve({
                        ...status,
                        enabledAccountCount: 1,
                        accounts: [account],
                      }),
                    statusDelayMs,
                  );
                signal?.addEventListener("abort", () => reject(signal.reason));
              });
            },
          },
        },
      });

      plugin(api);

      return harness;
    }

    it("waits for a slow pool answer instead of reporting a failure", async () => {
      const harness = slowPool(16_000);
      const reading = harness.callRpc("snapshot", null);
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(reading).resolves.toMatchObject({
        error: null,
        groups: [expect.objectContaining({ poolProvider: "claude" })],
      });
    });

    it("reports a pool that never answers in plain words", async () => {
      const harness = slowPool(null);
      const reading = harness.callRpc("snapshot", null);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(reading).resolves.toMatchObject({
        error: "no answer within 30 seconds",
        groups: [],
      });
    });
  });

  it("reads post-refresh usage after an older status request finishes", async () => {
    let reads = 0;
    let refreshes = 0;
    let release: (() => void) | undefined;

    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: async ({ method }) => {
            if (method === "config.get") return { switchThreshold: 0.98 };

            if (method === "account.refreshUsage") {
              refreshes += 1;

              return null;
            }

            reads += 1;

            const reading = {
              ...status,
              enabledAccountCount: 1,
              accounts: [
                {
                  ...account,
                  provider: "codex",
                  limitWindows: [
                    {
                      windowMinutes: 7 * 24 * 60,
                      utilization: refreshes > 0 ? 0.4 : 0.25,
                      resetAt: account.sevenDayResetAt,
                      status: "allowed",
                    },
                  ],
                },
              ],
            };

            if (reads > 1) return reading;
            await new Promise<void>((resolve) => {
              release = resolve;
            });

            return reading;
          },
        },
      },
    });

    plugin(api);
    const pending = harness.callRpc("snapshot", null);
    await vi.waitFor(() => expect(reads).toBe(1));
    const refreshed = harness.callRpc("refresh", null);
    await vi.waitFor(() => expect(refreshes).toBe(1));

    if (release === undefined)
      throw new Error("The initial usage read did not start");
    release();
    const before = snapshotSchema.parse(await pending);
    const after = snapshotSchema.parse(await refreshed);
    expect(before.groups[0]?.weeklyBars[0]?.remainingPercent).toBe(75);
    expect(after.groups[0]?.weeklyBars[0]?.remainingPercent).toBe(60);
    expect(refreshes).toBe(1);
  });

  it("preserves nested socket diagnostics without logging arbitrary request or socket data", async () => {
    const socketError = Object.assign(
      new Error("connect ECONNRESET 127.0.0.1:38886"),
      {
        code: "ECONNRESET",
        errno: -54,
        syscall: "connect",
        address: "127.0.0.1",
        port: 38886,
        request: { body: "private diagnostic payload" },
        socket: { privateData: "private socket payload" },
      },
    );

    const failure = new TypeError("fetch failed", {
      cause: new AggregateError([
        socketError,
        Object.assign(new Error("connect ECONNREFUSED ::1:38886"), {
          code: "ECONNREFUSED",
          syscall: "connect",
          address: "::1",
          port: 38886,
        }),
      ]),
    });

    socketError.cause = failure;

    const { api, harness } = createHost({
      pluginId: "omnyo--account-usage",
      sdk: {
        plugins: {
          callRpc: () => {
            throw failure;
          },
        },
      },
    });

    plugin(api);
    await expect(harness.callRpc("snapshot", null)).resolves.toMatchObject({
      error: "fetch failed",
      groups: [],
    });

    const diagnostic = harness.inspection.logEntries
      .map((entry) => entry.message)
      .join("\n");

    for (const value of [
      "ECONNRESET",
      "ECONNREFUSED",
      "127.0.0.1",
      "::1",
      "38886",
      '"errno":-54',
      '"syscall":"connect"',
      '"method":"status.get"',
    ]) {
      expect(diagnostic).toContain(value);
    }

    expect(diagnostic).not.toContain("private diagnostic payload");
    expect(diagnostic).not.toContain("private socket payload");
  });

  it("retains the native socket error from a real disconnected HTTP request", async () => {
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("The local diagnostic server did not bind TCP");

      const { api, harness } = createHost({
        pluginId: "omnyo--account-usage",
        sdk: {
          plugins: {
            callRpc: async () =>
              fetch(`http://127.0.0.1:${address.port}`, {
                method: "POST",
                body: "{}",
                signal: AbortSignal.timeout(3_000),
              }),
          },
        },
      });

      plugin(api);
      await expect(harness.callRpc("snapshot", null)).resolves.toMatchObject({
        error: "fetch failed",
        groups: [],
      });

      const diagnostic = harness.inspection.logEntries
        .map((entry) => entry.message)
        .join("\n");

      expect(diagnostic).toMatch(/"code":"(?:UND_ERR_SOCKET|ECONNRESET)"/);
      expect(diagnostic).toContain('"method":"status.get"');
      expect(diagnostic).toContain('"operation":"snapshot"');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
});
