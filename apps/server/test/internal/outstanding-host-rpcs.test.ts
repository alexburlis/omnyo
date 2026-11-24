import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { seedHost, seedSession } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function reopenSession(
  harness: TestAppHarness,
  session: { hostId: string; instanceId: string },
): Promise<void> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: session.hostId }),
    body: JSON.stringify({
      hostId: session.hostId,
      instanceId: session.instanceId,
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: "/tmp/host-daemon-reopened",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
    }),
  });

  expect(response.status).toBe(201);
}

async function leaveUnansweredHostRpc(
  harness: TestAppHarness,
  session: { hostId: string; sessionId: string },
): Promise<void> {
  harness.deps.hub.registerDaemon(
    session.sessionId,
    session.hostId,
    createMockHubSocket(),
  );
  await expect(
    harness.deps.hub.requestHostOnlineRpc({
      hostId: session.hostId,
      timeoutMs: 10,
      message: {
        type: "host-rpc.request",
        requestId: "unanswered",
        command: { type: "environment.hook.cancel", operationId: "op-1" },
      },
    }),
  ).rejects.toThrow("Timed out waiting for host RPC response");
}

describe("outstanding host RPCs across daemon sessions", () => {
  it("forgets requests that a replaced daemon instance can no longer answer", () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const session = seedSession(harness.deps, host.id, {
        instanceId: "instance-1",
      });

      await leaveUnansweredHostRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      expect(harness.deps.hub.countPendingHostRpcs(host.id)).toBe(1);

      await reopenSession(harness, {
        hostId: host.id,
        instanceId: "instance-2",
      });

      expect(harness.deps.hub.countPendingHostRpcs(host.id)).toBe(0);
    }));

  it("keeps requests across a reconnect of the same daemon instance", () =>
    withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const session = seedSession(harness.deps, host.id, {
        instanceId: "instance-1",
      });

      await leaveUnansweredHostRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      await reopenSession(harness, {
        hostId: host.id,
        instanceId: "instance-1",
      });

      expect(harness.deps.hub.countPendingHostRpcs(host.id)).toBe(1);
    }));
});
