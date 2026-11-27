import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  hostContract,
  nativeCommandSchema,
  rpcContract,
  type nativeRpcInputSchema,
} from "./contracts";
import type { z } from "zod";

export default function plugin(api: PluginApi): void {
  const host = api.hosts.experimental_client({ contract: hostContract });
  const lifetime = new AbortController();
  api.onDispose(() => lifetime.abort());

  async function native({ hostId, operation }: z.infer<typeof nativeRpcInputSchema>) {
    return host.call("native", operation, {
      hostId,
      signal: lifetime.signal,
      timeoutMs: 58_000,
    });
  }

  api.rpc.register(rpcContract, { native });
  api.cli.register({
    name: "desktop-helper",
    summary: "Probe the signed Mac Desktop Helper native boundary",
    commands: [
      {
        name: "native",
        summary: "Native status, probe, explicit permission request or shutdown",
        usage:
          "omnyo desktop-helper native --host <host-id> status|probe|shutdown|request-permissions accessibility|screen-capture",
      },
    ],
    async run(argv) {
      if (argv[0] !== "native")
        return {
          exitCode: 1,
          stderr:
            "Use omnyo desktop-helper native --host <host-id> status|probe|shutdown|request-permissions accessibility|screen-capture",
        };
      const flag = argv.indexOf("--host");
      const hostId = flag === 1 ? argv[2] : undefined;

      if (!hostId) return { exitCode: 1, stderr: "Pass the capture Mac with --host <host-id>." };
      const rest = argv.slice(3);
      const command = rest[0];

      const parsed = nativeCommandSchema.safeParse(
        command === "request-permissions" ? { command, permission: rest[1] } : { command },
      );

      if (!parsed.success || rest.length > (command === "request-permissions" ? 2 : 1))
        return { exitCode: 1, stderr: "Invalid native probe command." };

      return {
        exitCode: 0,
        stdout: JSON.stringify(await native({ hostId, operation: parsed.data }), null, 2),
      };
    },
  });
}
