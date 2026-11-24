import { describe, expect, it } from "vitest";
import {
  hostDaemonOnlineRpcCommandSchema,
  parseHostDaemonOnlineRpcResultForCommand,
} from "../src/commands.js";
import { hostDaemonOnlineRpcResponseMessageSchema } from "../src/session.js";

describe("native Claude profile host RPC", () => {
  it("preserves the selected profile when requesting its model catalog", () => {
    const profileId = "00000000-0000-4000-8000-000000000001";

    const result = hostDaemonOnlineRpcCommandSchema.safeParse({
      type: "provider.list_models",
      providerId: "claude-code",
      bridgeLaunch: {
        pluginId: "provider-claude-code",
        source: { kind: "artifact", digest: "a".repeat(64), byteLength: 1 },
        capabilities: {
          providerInstallation: false,
          supportsServiceTier: false,
          permissionModes: ["full"],
          supportsThreadArchive: false,
          supportsThreadRename: false,
          fork: "none",
        },
        providerOptions: {},
        envPassthrough: [],
      },
      contributedEnv: [],
      claudeProfileBinding: { profileId },
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data).toHaveProperty("claudeProfileBinding", { profileId });
  });

  it("serializes a successful profile list reply through the daemon wire", () => {
    const command = {
      type: "claude-profile/manage",
      request: { action: "list" },
    } as const;

    const result = { action: "list", supported: true, profiles: [] };

    expect(hostDaemonOnlineRpcCommandSchema.parse(command)).toEqual(command);
    expect(parseHostDaemonOnlineRpcResultForCommand(command, result)).toEqual(
      result,
    );
    expect(
      hostDaemonOnlineRpcResponseMessageSchema.parse({
        type: "host-rpc.response",
        requestId: "native-claude-profile-list",
        commandType: command.type,
        ok: true,
        result,
      }),
    ).toMatchObject({ result });
  });
});
