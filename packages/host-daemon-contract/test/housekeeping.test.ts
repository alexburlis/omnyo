import { hostDaemonOnlineRpcResponseMessageSchema } from "../src/session.js";
import { describe, expect, it } from "vitest";
import {
  hostDaemonOnlineRpcCommandSchema,
  parseHostDaemonOnlineRpcResultForCommand,
} from "../src/commands.js";
import { hostHousekeepingStatusSchema } from "../src/housekeeping.js";

describe("housekeeping command contract", () => {
  it("accepts only the read-only inspection command", () => {
    const command = { type: "host.housekeeping.status" } as const;
    expect(hostDaemonOnlineRpcCommandSchema.parse(command)).toEqual(command);
    expect(
      hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        requestId: "housekeeping-request",
        commandType: command.type,
        ok: true,
        result: { status: "not-run" },
      }),
    ).toMatchObject({ result: { status: "not-run" } });
    expect(
      parseHostDaemonOnlineRpcResultForCommand(command, { status: "not-run" }),
    ).toEqual({ status: "not-run" });
  });

  it("does not accept a failed check as an empty successful inspection", () => {
    expect(
      hostHousekeepingStatusSchema.safeParse({
        status: "complete",
        reapedSessions: [],
        retainedSessions: [],
      }).success,
    ).toBe(false);
  });
});
