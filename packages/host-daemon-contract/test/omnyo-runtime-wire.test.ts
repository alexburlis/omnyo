import { describe, expect, it } from "vitest";
import {
  hostDaemonOnlineRpcCommandSchema,
  HOST_DAEMON_PROTOCOL_VERSION,
} from "../src/index.js";

describe("Omnyo runtime wire transition", () => {
  const runtime = {
    downloadPath: "/runtime",
    sha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
    sizeBytes: 128,
    version: "0.46.241",
  };

  const command = {
    type: "server_move.prepare",
    moveId: "move-stable",
    activationToken: "synthetic-activation-token",
    archive: {
      downloadPath: "/archive",
      sha256: "c".repeat(64),
      sizeBytes: 64,
    },
    appRuntime: runtime,
    serverPort: 4840,
    bindHost: "127.0.0.1",
    sourceDataDir: "/state/source",
    sourceServerHostId: "host-stable",
    serverUrl: "http://127.0.0.1:4840",
    archiveExistingServerData: false,
  };

  it("accepts the canonical runtime field without changing artifact or host identity", () => {
    expect(HOST_DAEMON_PROTOCOL_VERSION).toBeGreaterThan(252);
    expect(hostDaemonOnlineRpcCommandSchema.parse(command)).toEqual(command);
  });

  it("refuses renamed, duplicated and unknown runtime fields", () => {
    const { appRuntime, ...rest } = command;
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...rest,
        runtime: appRuntime,
      }).success,
    ).toBe(false);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...command,
        runtime: appRuntime,
      }).success,
    ).toBe(false);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...command,
        appRuntime: { ...runtime, runtimeSha256: "invalid" },
      }).success,
    ).toBe(false);
  });
});
