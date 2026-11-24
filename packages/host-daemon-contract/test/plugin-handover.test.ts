import { describe, expect, it } from "vitest";
import { hostDaemonOnlineRpcCommandSchema } from "../src/index.js";

const call = {
  type: "plugin.host.call",
  pluginId: "fixture",
  generation: "generation-2",
  artifact: { digest: "a".repeat(64), byteLength: 1 },
  callId: "control-call",
  method: "status",
  input: null,
  timeoutMs: 1000,
};

describe("retained host worker wire compatibility", () => {
  it("defaults legacy calls to no replacement permission and preserves explicit keys", () => {
    expect(hostDaemonOnlineRpcCommandSchema.parse(call)).toMatchObject({
      replacementKey: null,
    });
    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        ...call,
        replacementKey: "resource-control-v1",
      }),
    ).toMatchObject({ replacementKey: "resource-control-v1" });
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...call,
        replacementKey: "",
      }).success,
    ).toBe(false);
    expect(
      hostDaemonOnlineRpcCommandSchema.safeParse({
        ...call,
        replacementKey: "a".repeat(129),
      }).success,
    ).toBe(false);
  });

  it("keeps legacy disposal generation-bound and allows explicit retained-worker disposal", () => {
    const dispose = {
      type: "plugin.host.dispose",
      pluginId: "fixture",
      generation: "generation-2",
    };

    expect(hostDaemonOnlineRpcCommandSchema.parse(dispose)).toMatchObject({
      includeRetained: false,
    });
    expect(
      hostDaemonOnlineRpcCommandSchema.parse({
        ...dispose,
        includeRetained: true,
      }),
    ).toMatchObject({ includeRetained: true });
  });
});
