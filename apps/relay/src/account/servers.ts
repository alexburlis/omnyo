import { eq } from "drizzle-orm";
import {
  type ConnectDb,
  isLive,
  SERVER_OFFLINE_AFTER_MS,
  server,
  type TunnelConnectedLookup,
} from "@omnyo/connect-db";

export interface AccountServerListing {
  handle: string;
  name: string;
  live: boolean;
}

export async function listAccountServers(
  db: ConnectDb,
  userId: string,
  now: number,
  tunnelConnected: TunnelConnectedLookup | null,
): Promise<AccountServerListing[]> {
  const rows = await db
    .select({
      subdomain: server.subdomain,
      name: server.name,
      lastSeenAt: server.lastSeenAt,
      credentialHash: server.credentialHash,
      revokedAt: server.revokedAt,
    })
    .from(server)
    .where(eq(server.userId, userId))
    .all();

  return Promise.all(
    rows.map(async (row) => {
      const handle = row.subdomain;
      const trimmed = row.name.trim();
      const connected = row.credentialHash != null && row.revokedAt == null;

      const live =
        connected &&
        isLive({
          lastSeenMs: row.lastSeenAt?.getTime() ?? null,
          now,
          offlineAfterMs: SERVER_OFFLINE_AFTER_MS,
          tunnelConnected:
            tunnelConnected === null ? null : await tunnelConnected(handle),
        });

      return { handle, name: trimmed.length > 0 ? trimmed : handle, live };
    }),
  );
}
