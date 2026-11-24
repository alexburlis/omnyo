import type { RelayConfig } from "../config.js";
import type { TunnelRegistry } from "../contracts.js";
import type { RelayDatabase } from "../db.js";
import {
  type AccountRevocation,
  type Deps,
  resolveServerUrlTemplate,
} from "./api.js";

export const OWNER_REVOKED_CLOSE_REASON = "revoked by owner";

export type AccountTunnels = Pick<TunnelRegistry, "has" | "close">;

export interface AccountRevocations {
  record(revocation: AccountRevocation): void;
}

export function serverUrlTemplateFor(
  config: Pick<RelayConfig, "appUrl" | "baseDomain">,
): string {
  const appUrl = new URL(config.appUrl);
  const port = appUrl.port === "" ? "" : `:${appUrl.port}`;

  return resolveServerUrlTemplate(
    `${appUrl.protocol}//{label}.${config.baseDomain}${port}`,
    config.baseDomain,
  );
}

export function accountDepsFrom(input: {
  config: Pick<RelayConfig, "appUrl" | "baseDomain">;
  database: Pick<RelayDatabase, "db">;
  tunnels: AccountTunnels;
  revocations: AccountRevocations;
}): Deps {
  const { tunnels } = input;

  return {
    db: input.database.db,
    appUrl: input.config.appUrl,
    serverUrlTemplate: serverUrlTemplateFor(input.config),
    closeTunnel: async (routingKey) => {
      tunnels.close(routingKey, OWNER_REVOKED_CLOSE_REASON);
    },
    recordRevocation: (revocation) => input.revocations.record(revocation),
    tunnelConnected: async (routingKey) => tunnels.has(routingKey),
  };
}
