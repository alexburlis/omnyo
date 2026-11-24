import { afterEach, expect, it, vi } from "vitest";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import {
  startLocalApiServer,
  type LocalApiServer,
  type WorkerManagementStatus,
} from "./local-api.js";
import type { ProtocolSelfUpdateTarget } from "./protocol-self-update.js";

const servers: LocalApiServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const managementKey = "fixture-management-key";

const status: WorkerManagementStatus = {
  managementVersion: 1,
  hostId: "host_fixture",
  instanceId: "instance_fixture",
  runtimeVersion: "1.0.0+private.1",
  protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
  serverUrl: "https://server.example.test",
  connected: true,
  automaticUpdates: true,
  admission: {
    activity: null,
    held: false,
    holdOwner: null,
    directProbe: false,
    activation: false,
    blockers: [],
  },
  pluginBlockers: [],
  update: { phase: "idle", target: null, reason: null, retryAt: null },
};

async function requestUpdate(version: string) {
  const requested = vi.fn(
    async (_target: ProtocolSelfUpdateTarget) => "updated" as const,
  );

  const server = await startLocalApiServer({
    hostId: status.hostId,
    localApiConfig: {
      bindHost: "127.0.0.1",
      healthPath: "/health",
      healthValue: "ok",
      port: 0,
    },
    serverUrl: status.serverUrl,
    serverPort: 0,
    getConnected: () => true,
    management: {
      hostKey: managementKey,
      getStatus: () => status,
      requestUpdate: requested,
    },
  });

  servers.push(server);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/management/v1/update`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${managementKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedHostId: status.hostId,
        expectedInstanceId: status.instanceId,
        target: {
          version,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          artifactDigest: "a".repeat(64),
        },
      }),
    },
  );

  return { requested, status: response.status };
}

it.each(["1.0.1", "1.0.0+private.1"])(
  "accepts a management update to %s",
  async (version) => {
    const result = await requestUpdate(version);
    expect(result.status).toBe(200);
    expect(result.requested).toHaveBeenCalledWith({
      version,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      artifactDigest: "a".repeat(64),
    });
  },
);

it.each(["1.0", "1.0.1-beta", "1.0.1+build.1"])(
  "refuses a management update to %s",
  async (version) => {
    const result = await requestUpdate(version);
    expect(result.status).toBe(400);
    expect(result.requested).not.toHaveBeenCalled();
  },
);
