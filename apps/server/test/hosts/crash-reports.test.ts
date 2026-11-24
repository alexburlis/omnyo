import { defaultAppSettings, type AppSettings } from "@omnyo/domain";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonServerWsMessageSchema,
} from "@omnyo/host-daemon-contract";
import { setProcessErrorReportingEnabled } from "@omnyo/process-utils/error-reporting";
import { describe, expect, it } from "vitest";
import { onDaemonSocketOpen } from "../../src/ws/daemon-protocol.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { seedHost } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

type MockHubSocket = ReturnType<typeof createMockHubSocket>;

let connections = 0;

function crashReportMessages(socket: MockHubSocket) {
  return socket.messages.flatMap((data) => {
    const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));

    return message.type === "diagnostics-policy.replace"
      ? [message.policy]
      : [];
  });
}

async function openDaemonSession(
  harness: TestAppHarness,
  args: {
    hostId: string;
    instanceId: string;
  },
): Promise<string> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      hostId: args.hostId,
      instanceId: args.instanceId,
      hostName: "Crash Reports Host",
      hasMachineCredential: false,
      platform: "win32",
      dataDir: "C:\\omnyo-data",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      openThreadWork: [],
      undeliveredEventThreadIds: [],
      loadedEnvironments: [],
      runtimeVersion: "1.0.47",
      automaticUpdates: true,
    }),
  });

  expect(response.status).toBe(201);

  const { sessionId } = (await response.json()) as { sessionId: string };

  return sessionId;
}

async function connectDaemon(
  harness: TestAppHarness,
  args: { hostId: string },
) {
  connections += 1;

  const sessionId = await openDaemonSession(harness, {
    ...args,
    instanceId: `instance-${String(connections)}`,
  });

  const socket = createMockHubSocket();
  onDaemonSocketOpen(harness.deps, {
    hostId: args.hostId,
    sessionId,
    socket,
  });

  return { sessionId, socket };
}

async function putGeneralSettings(
  harness: TestAppHarness,
  settings: Partial<AppSettings>,
) {
  const response = await harness.app.request("/api/v1/settings/general", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...defaultAppSettings, ...settings }),
  });

  expect(response.status).toBe(200);
}

describe("host daemon crash reports setting", () => {
  it("caps a production-capable daemon when the coordinator has no diagnostics recipient", async () => {
    await withTestHarness(async (harness) => {
      harness.config.isDevelopment = false;
      const host = seedHost(harness.deps, { id: "beta-diagnostics-host" });
      const first = await connectDaemon(harness, { hostId: host.id });
      expect(
        crashReportMessages(first.socket).at(-1)?.crashReportsEnabled,
      ).toBe(false);
      await putGeneralSettings(harness, { crashReportsEnabled: true });
      expect(
        crashReportMessages(first.socket).at(-1)?.crashReportsEnabled,
      ).toBe(false);
      const reconnected = await connectDaemon(harness, { hostId: host.id });
      expect(
        crashReportMessages(reconnected.socket).at(-1)?.crashReportsEnabled,
      ).toBe(false);
    });
  });

  it("synchronizes current policy without capability opt-in and stops updating a replaced socket", async () => {
    await withTestHarness(async (harness) => {
      harness.config.isDevelopment = false;
      harness.config.errorReportingDsn = "https://public@sentry.invalid/42";

      try {
        const host = seedHost(harness.deps, { id: "diagnostics-host" });
        const first = await connectDaemon(harness, { hostId: host.id });
        expect(
          crashReportMessages(first.socket).at(-1)?.crashReportsEnabled,
        ).toBe(true);
        await putGeneralSettings(harness, { crashReportsEnabled: false });
        expect(
          crashReportMessages(first.socket).at(-1)?.crashReportsEnabled,
        ).toBe(false);
        const previous = crashReportMessages(first.socket);
        const reconnected = await connectDaemon(harness, { hostId: host.id });
        expect(
          crashReportMessages(reconnected.socket).at(-1)?.crashReportsEnabled,
        ).toBe(false);
        await putGeneralSettings(harness, { crashReportsEnabled: true });
        expect(
          crashReportMessages(reconnected.socket).at(-1)?.crashReportsEnabled,
        ).toBe(true);
        expect(crashReportMessages(first.socket)).toEqual(previous);

        const policies = [
          ...previous,
          ...crashReportMessages(reconnected.socket),
        ];

        expect(
          policies.every(
            (policy, index) =>
              index === 0 ||
              policy.revision > (policies[index - 1]?.revision ?? -1),
          ),
        ).toBe(true);
      } finally {
        setProcessErrorReportingEnabled(true);
      }
    });
  });

  it.each([
    { replacement: "the same daemon instance", sameInstance: true },
    { replacement: "a restarted daemon", sameInstance: false },
  ])(
    "forgets a session's runtime when $replacement replaces it before its socket connects",
    async ({ sameInstance }) => {
      await withTestHarness(async (harness) => {
        const host = seedHost(harness.deps, { id: "crash-reports-replaced" });

        const unconnected = await openDaemonSession(harness, {
          hostId: host.id,
          instanceId: "instance-unconnected",
        });

        const replacement = await openDaemonSession(harness, {
          hostId: host.id,
          instanceId: sameInstance
            ? "instance-unconnected"
            : "instance-restarted",
        });

        expect(
          harness.hub.getDaemonSessionRuntimeVersion(unconnected),
        ).toBeNull();
        expect(harness.hub.getDaemonSessionRuntimeVersion(replacement)).toBe(
          "1.0.47",
        );
      });
    },
  );
});
