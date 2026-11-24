import { readServerConnectHoldFile } from "@omnyo/server-archive";
import type { ServerLogger } from "../../types.js";
import type { PluginLoadHold } from "../plugins/plugin-runtime.js";
import {
  CONNECT_PLUGIN_SOURCE,
  LEGACY_OMNYO_ACCOUNT_PLUGIN_SOURCE,
  OMNYO_ACCOUNT_PLUGIN_SOURCE,
} from "./mode.js";

export const CONNECT_HOLD_DETAIL =
  "Off after omnyo server import so this server can't take the original server's tunnel or use its Omnyo account. Stop the original server, run omnyo server allow-connect, then restart Omnyo.";

export const CONNECT_HOLD_SOURCES = [
  CONNECT_PLUGIN_SOURCE,
  OMNYO_ACCOUNT_PLUGIN_SOURCE,
  LEGACY_OMNYO_ACCOUNT_PLUGIN_SOURCE,
] as const;

export interface CreateConnectHoldArgs {
  dataDir: string;
  logger: Pick<ServerLogger, "warn">;
}

export function createConnectHold(args: CreateConnectHoldArgs): PluginLoadHold {
  return {
    sources: CONNECT_HOLD_SOURCES,
    detail: CONNECT_HOLD_DETAIL,
    isActive: async () => {
      try {
        return (await readServerConnectHoldFile(args.dataDir)) !== null;
      } catch (error) {
        args.logger.warn(
          { err: error },
          "Could not read server-connect-hold.json, so Omnyo connect and Omnyo account stay off",
        );

        return true;
      }
    },
  };
}
