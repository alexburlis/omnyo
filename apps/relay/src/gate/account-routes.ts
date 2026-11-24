import { eq } from "drizzle-orm";
import { SERVER_OFFLINE_AFTER_MS, isLive, server } from "@omnyo/connect-db";
import { z } from "zod";
import type { RelayDb } from "../db.js";
import { RelayLabelLimitError } from "../reserved-labels.js";
import { isUserBlocked } from "../user-blocks.js";
import {
  type DesktopSessionAccount,
  issueDesktopSessionCookie,
} from "./desktop-session.js";
import {
  MachineLabelUnavailableError,
  assignMachineLabel,
} from "./machine-label.js";
import { MACHINE_CREDENTIAL_HEADER } from "./protocol-headers.js";
import {
  type DeviceIdentity,
  deviceBelongsToServer,
  verifyMachineCredential,
  verifyServerCredential,
} from "./resolve.js";
import { type RevocationDeps, revokeServerByCredential } from "./revocation.js";
import type { PurposeKey } from "./signed-token.js";

export const TENANT_ACCOUNT_ROUTES: ReadonlySet<string> = new Set([
  "/api/connect/servers",
  "/api/connect/disconnect",
  "/api/connect/desktop-session",
  "/api/connect/machine-label",
]);

export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow: "GET" | "POST"): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, { allow });
}

function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

export function resolveBearerAccount(
  db: RelayDb,
  credential: string,
): DesktopSessionAccount | null {
  const verifiedMachine = verifyMachineCredential(db, credential);

  if (verifiedMachine !== null && isUserBlocked(db, verifiedMachine.userId)) {
    return null;
  }

  if (verifiedMachine !== null) {
    return {
      userId: verifiedMachine.userId,
      grant: {
        kind: "machine",
        credentialHash: verifiedMachine.credentialHash,
      },
    };
  }

  const verifiedServer = verifyServerCredential(db, credential);

  return verifiedServer === null || isUserBlocked(db, verifiedServer.userId)
    ? null
    : {
        userId: verifiedServer.userId,
        grant: {
          kind: "server",
          credentialHash: verifiedServer.credentialHash,
        },
      };
}

export interface AccountServerListing {
  handle: string;
  name: string;
  live: boolean;
}

export function listAccountServers(
  db: RelayDb,
  userId: string,
  now: number,
  tunnelConnected: (routingKey: string) => boolean,
  device: DeviceIdentity | null,
): AccountServerListing[] {
  const rows = db
    .select({
      id: server.id,
      createdAt: server.createdAt,
      subdomain: server.subdomain,
      name: server.name,
      lastSeenAt: server.lastSeenAt,
      credentialHash: server.credentialHash,
      revokedAt: server.revokedAt,
    })
    .from(server)
    .where(eq(server.userId, userId))
    .all()
    .filter(
      (row) =>
        device === null ||
        deviceBelongsToServer(device, {
          serverId: row.id,
          userId,
          createdAt: row.createdAt.getTime(),
        }),
    );

  return rows.map((row) => {
    const trimmed = row.name.trim();
    const connected = row.credentialHash !== null && row.revokedAt === null;

    return {
      handle: row.subdomain,
      name: trimmed.length > 0 ? trimmed : row.subdomain,
      live:
        connected &&
        isLive({
          lastSeenMs: row.lastSeenAt?.getTime() ?? null,
          now,
          offlineAfterMs: SERVER_OFFLINE_AFTER_MS,
          tunnelConnected: tunnelConnected(row.subdomain),
        }),
    };
  });
}

const machineLabelBodySchema = z.object({ desiredName: z.string() });

export interface TenantAccountRouteDeps extends RevocationDeps {
  desktopKey: PurposeKey;
  baseDomain: string;
  desktopCookieName: string;
  bearerGuard: BearerFailureGuard;
}

export interface BearerFailureGuard {
  isBlocked(): boolean;
  recordFailure(): Promise<void>;
}

export function rateLimitedResponse(): Response {
  return jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "60" });
}

export async function refuseCredential(
  guard: BearerFailureGuard,
  refusal: Response,
): Promise<Response> {
  if (guard.isBlocked()) return rateLimitedResponse();
  await guard.recordFailure();

  return refusal;
}

export async function handleTenantAccountRoute(
  request: Request,
  pathname: string,
  deps: TenantAccountRouteDeps,
): Promise<Response> {
  const credential =
    request.headers.get(MACHINE_CREDENTIAL_HEADER)?.trim() ?? "";

  const refuse = (): Promise<Response> =>
    refuseCredential(deps.bearerGuard, unauthorized());

  if (pathname === "/api/connect/servers") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const account = resolveBearerAccount(deps.db, credential);

    if (account === null) return refuse();

    return jsonResponse(
      {
        servers: listAccountServers(
          deps.db,
          account.userId,
          deps.now(),
          (key) => deps.tunnels.has(key),
          account.grant.kind === "machine"
            ? verifyMachineCredential(deps.db, credential)
            : null,
        ),
      },
      200,
    );
  }

  if (pathname === "/api/connect/disconnect") {
    if (request.method !== "POST") return methodNotAllowed("POST");

    return revokeServerByCredential(deps, credential) === null
      ? refuse()
      : jsonResponse({ ok: true }, 200);
  }

  if (pathname === "/api/connect/desktop-session") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const account = resolveBearerAccount(deps.db, credential);

    if (account === null) return refuse();

    return jsonResponse(
      {
        cookie: issueDesktopSessionCookie(
          account,
          {
            key: deps.desktopKey,
            baseDomain: deps.baseDomain,
            name: deps.desktopCookieName,
          },
          deps.now(),
        ),
      },
      200,
    );
  }

  if (request.method !== "POST") return methodNotAllowed("POST");
  const verified = verifyMachineCredential(deps.db, credential);

  if (verified === null || isUserBlocked(deps.db, verified.userId)) {
    return refuse();
  }

  const body = machineLabelBodySchema.safeParse(
    await request.json().catch(() => null),
  );

  if (!body.success) return jsonResponse({ error: "invalid_request" }, 400);

  let label: string | null;

  try {
    label = assignMachineLabel(
      deps.db,
      verified.machineId,
      body.data.desiredName,
    );
  } catch (error) {
    if (error instanceof RelayLabelLimitError)
      return jsonResponse({ error: "label_limit" }, 409);

    if (error instanceof MachineLabelUnavailableError)
      return jsonResponse({ error: "label_unavailable" }, 409);
    throw error;
  }

  return label === null ? unauthorized() : jsonResponse({ label }, 200);
}
