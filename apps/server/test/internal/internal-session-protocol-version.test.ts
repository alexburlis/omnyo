import WebSocket from "ws";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  buildHostDaemonWebSocketProtocols,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenResponseSchema,
  type HostDaemonInternalSchema,
} from "@omnyo/host-daemon-contract";
import type { Hono } from "hono";
import { hc } from "hono/client";
import { describe, expect, it, vi } from "vitest";
import {
  getAppSettings,
  setAppSettings,
  getHost,
  getLatestSessionForHost,
  updateHost,
  upsertHost,
} from "@omnyo/db";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

function createHostDaemonClient(baseUrl: string, hostKey: string) {
  return hc<Hono<{}, HostDaemonInternalSchema, "/">>(`${baseUrl}/internal`, {
    headers: { authorization: `Bearer ${hostKey}` },
  });
}

describe("internal session protocol version", () => {
  it("sends current socket policy after an enabled HTTP handshake became stale", async () => {
    const server = await startTestServer();
    let socket: WebSocket | undefined;

    try {
      const hostId = "host-diagnostics-race";
      const hostKey = createTestDaemonHostKey({ hostId });
      upsertHost(server.db, server.hub, {
        id: hostId,
        name: "Diagnostics Host",
      });

      const response = await createHostDaemonClient(
        server.baseUrl,
        hostKey,
      ).session.open.$post({
        json: {
          hostId,
          instanceId: "diagnostics-instance",
          hostName: "Diagnostics Host",
          hasMachineCredential: false,
          platform: "linux",
          dataDir: "/tmp/diagnostics-host",
          localApiPort: null,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
          runtimeVersion: null,
          automaticUpdates: false,
        },
      });

      expect(response.status).toBe(201);

      const handshake = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      );

      expect(handshake.diagnosticsPolicy.crashReportsEnabled).toBe(true);
      setAppSettings(server.db, {
        ...getAppSettings(server.db),
        crashReportsEnabled: false,
      });

      const policies: Array<{
        revision: number;
        crashReportsEnabled: boolean;
      }> = [];

      socket = new WebSocket(
        `${server.baseUrl.replace("http:", "ws:")}/internal/ws?sessionId=${handshake.sessionId}`,
        buildHostDaemonWebSocketProtocols(),
        { headers: { authorization: `Bearer ${hostKey}` } },
      );
      socket.on("message", (data) => {
        const message = hostDaemonServerWsMessageSchema.parse(
          JSON.parse(data.toString()),
        );

        if (message.type === "diagnostics-policy.replace")
          policies.push(message.policy);
      });
      await vi.waitFor(() => expect(policies.length).toBeGreaterThan(0));
      expect(policies.every((policy) => !policy.crashReportsEnabled)).toBe(
        true,
      );
      const previousRevision = policies.at(-1)?.revision ?? -1;
      setAppSettings(server.db, {
        ...getAppSettings(server.db),
        crashReportsEnabled: true,
      });
      server.hub.notifySystem(["config-changed"]);
      await vi.waitFor(() =>
        expect(policies.at(-1)?.crashReportsEnabled).toBe(true),
      );
      expect(policies.at(-1)?.revision).toBeGreaterThan(previousRevision);
    } finally {
      socket?.terminate();
      await server.close();
    }
  });

  it.each([235, 236, 244])(
    "refuses historical protocol %s before admitting canonical wire traffic",
    async (protocolVersion) => {
      const server = await startTestServer();

      try {
        const hostId = "host-compatible-private-runtime";
        upsertHost(server.db, server.hub, { id: hostId, name: "Busy Worker" });

        const daemonClient = createHostDaemonClient(
          server.baseUrl,
          createTestDaemonHostKey({ hostId }),
        );

        const response = await daemonClient.session.open.$post({
          json: {
            hostId,
            instanceId: "existing-private-runtime",
            hostName: "Busy Worker",
            hasMachineCredential: true,
            platform: "win32",
            dataDir: "/tmp/compatible-private-runtime",
            localApiPort: 38_888,
            protocolVersion,
            activeThreads: [],
            undeliveredEventThreadIds: [],
            loadedEnvironments: [],
            runtimeVersion: null,
            automaticUpdates: false,
          },
        });

        expect(response.status).toBe(400);
        expect(getHost(server.db, hostId)?.lastRejectedProtocolVersion).toBe(
          protocolVersion,
        );
        expect(getLatestSessionForHost(server.db, { hostId })).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  it.each(["suspending", "suspended"] as const)(
    "rejects a session open while the machine is %s",
    async (phase) => {
      const server = await startTestServer();

      try {
        const hostId = `host-${phase}`;
        const hostKey = createTestDaemonHostKey({ hostId });
        upsertHost(server.db, server.hub, { id: hostId, name: "Paused Host" });
        updateHost(server.db, server.hub, hostId, { phase });

        const response = await fetch(
          `${server.baseUrl}/internal/session/open`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${hostKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              hostId,
              instanceId: `instance-${phase}`,
              hostName: "Paused Host",
              hasMachineCredential: true,
              platform: "linux",
              dataDir: `/tmp/${hostId}`,
              localApiPort: 38_888,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              activeThreads: [],
              undeliveredEventThreadIds: [],
              loadedEnvironments: [],
            }),
          },
        );

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "machine_suspended",
          message:
            "Machine daemon sessions are disabled while the machine is suspending or suspended",
        });
      } finally {
        await server.close();
      }
    },
  );

  it("accepts a session open while the machine is resuming", async () => {
    const server = await startTestServer();

    try {
      const hostId = "host-resuming";
      const hostKey = createTestDaemonHostKey({ hostId });
      upsertHost(server.db, server.hub, { id: hostId, name: "Resuming Host" });
      updateHost(server.db, server.hub, hostId, { phase: "resuming" });

      const response = await fetch(`${server.baseUrl}/internal/session/open`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${hostKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId,
          instanceId: "instance-resuming",
          hostName: "Resuming Host",
          hasMachineCredential: true,
          platform: "linux",
          dataDir: `/tmp/${hostId}`,
          localApiPort: 38_888,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
        }),
      });

      expect(response.status).toBe(201);
    } finally {
      await server.close();
    }
  });

  it.each([
    { openThreadWork: undefined, answersEndedRequests: false },
    { openThreadWork: [], answersEndedRequests: true },
  ])(
    "answers ended questions only to a daemon that reports open work ($answersEndedRequests)",
    async ({ openThreadWork, answersEndedRequests }) => {
      const server = await startTestServer();

      try {
        const hostId = "host-open-work-reporting";
        const hostKey = createTestDaemonHostKey({ hostId });
        upsertHost(server.db, server.hub, { id: hostId, name: "Worker" });

        const response = await fetch(
          `${server.baseUrl}/internal/session/open`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${hostKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              hostId,
              instanceId: "instance-open-work-reporting",
              hostName: "Worker",
              hasMachineCredential: true,
              platform: "linux",
              dataDir: `/tmp/${hostId}`,
              localApiPort: 38_888,
              protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
              activeThreads: [],
              ...(openThreadWork === undefined ? {} : { openThreadWork }),
            }),
          },
        );

        expect(response.status).toBe(201);
        expect(
          Object.hasOwn(await response.json(), "endedInteractiveRequests"),
        ).toBe(answersEndedRequests);
      } finally {
        await server.close();
      }
    },
  );

  it("rejects stale and future session protocols without creating a session", async () => {
    const server = await startTestServer();

    try {
      const hostKey = createTestDaemonHostKey({ hostId: "host-protocol" });
      upsertHost(server.db, server.hub, {
        id: "host-protocol",
        name: "Protocol Host",
      });
      const daemonClient = createHostDaemonClient(server.baseUrl, hostKey);
      const staleProtocolVersion = 234;

      const priorProtocolResponse = await fetch(
        `${server.baseUrl}/internal/session/open`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${hostKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host-protocol",
            instanceId: "instance-protocol-pr1",
            hostName: "Protocol Host",
            hostType: "persistent",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-protocol-data",
            localApiPort: 38_888,
            protocolVersion: 188,
            activeThreads: [],
            undeliveredEventThreadIds: [],
            loadedEnvironments: [],
          }),
        },
      );

      expect(priorProtocolResponse.status).toBe(400);
      expect(await priorProtocolResponse.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: false,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        message: `Daemon protocol version 188 does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
      });
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBe(188);

      const preLocalApiPortProtocolVersion = 139;

      const oldDaemonResponse = await fetch(
        `${server.baseUrl}/internal/session/open`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${hostKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host-protocol",
            instanceId: "instance-pre-local-api-port",
            hostName: "Protocol Host",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-protocol-data",
            protocolVersion: preLocalApiPortProtocolVersion,
            activeThreads: [],
            undeliveredEventThreadIds: [],
            loadedEnvironments: [],
          }),
        },
      );

      expect(oldDaemonResponse.status).toBe(400);
      expect(await oldDaemonResponse.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: false,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        message: `Daemon protocol version ${preLocalApiPortProtocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
      });
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBe(preLocalApiPortProtocolVersion);

      for (const protocolVersion of [
        staleProtocolVersion,
        HOST_DAEMON_PROTOCOL_VERSION + 1,
      ]) {
        const response = await daemonClient.session.open.$post({
          json: {
            hostId: "host-protocol",
            instanceId: "instance-1",
            hostName: "Protocol Host",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-protocol-data",
            localApiPort: 38_888,
            protocolVersion,
            activeThreads: [],
            undeliveredEventThreadIds: [],
            loadedEnvironments: [],
            runtimeVersion: null,
            automaticUpdates: false,
          },
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "protocol_version_mismatch",
          details: {
            retryUpdate: false,
            serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          },
          message: `Daemon protocol version ${protocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
        });
        expect(
          getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
        ).toBe(protocolVersion);
        expect(
          getLatestSessionForHost(server.db, { hostId: "host-protocol" }),
        ).toBeNull();
        await expect(
          fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
            result.json(),
          ),
        ).resolves.toMatchObject({
          lastRejectedProtocolVersion: protocolVersion,
        });
      }

      server.hub.requestHostProtocolUpdateRetry("host-protocol");

      const forcedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry",
          hostName: "Protocol Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
          runtimeVersion: null,
          automaticUpdates: false,
        },
      });

      expect(await forcedRetry.json()).toMatchObject({
        details: { retryUpdate: true },
      });

      const consumedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry-consumed",
          hostName: "Protocol Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
          runtimeVersion: null,
          automaticUpdates: false,
        },
      });

      expect(await consumedRetry.json()).toMatchObject({
        details: { retryUpdate: false },
      });

      const accepted = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-2",
          hostName: "Protocol Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
          runtimeVersion: null,
          automaticUpdates: false,
        },
      });

      expect(accepted.status).toBe(201);
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBeNull();
      await expect(
        fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
          result.json(),
        ),
      ).resolves.toMatchObject({ lastRejectedProtocolVersion: null });
    } finally {
      await server.close();
    }
  });
});
