import type { RelayConfig } from "../config.js";
import type { RelayDatabase } from "../db.js";
import { createRelayBetterAuth, type RelayBetterAuth } from "./better-auth.js";
import { createAuthService, type RelayAuthService } from "./auth-service.js";
import { deriveRelayKeys, type RelayKeys } from "./keys.js";

export interface RelayAuth {
  keys: RelayKeys;
  betterAuth: RelayBetterAuth;
  service: RelayAuthService;
}

export function createRelayAuth(
  config: Pick<RelayConfig, "appUrl" | "betterAuthSecret" | "github">,
  database: Pick<RelayDatabase, "db">,
): RelayAuth {
  const keys = deriveRelayKeys(config.betterAuthSecret);

  const auth = createRelayBetterAuth({
    appUrl: config.appUrl,
    secret: keys.betterAuthSecret,
    github: config.github,
    db: database.db,
  });

  return {
    keys,
    betterAuth: auth,
    service: createAuthService({
      auth,
      db: database.db,
      appUrl: config.appUrl,
    }),
  };
}
