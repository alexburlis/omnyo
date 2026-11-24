import {
  CONNECT_SESSION_EXPIRES_IN_SECONDS,
  CONNECT_SESSION_UPDATE_AGE_SECONDS,
} from "@omnyo/connect-db";
import { z } from "zod";
import type { RelayDb } from "../db.js";
import { liveMachineByHash, liveServerByHash } from "./resolve.js";
import { type PurposeKey, signToken, verifyToken } from "./signed-token.js";

export const DESKTOP_SESSION_TTL_MS = CONNECT_SESSION_EXPIRES_IN_SECONDS * 1000;

const DESKTOP_SESSION_REFRESH_AFTER_MS =
  CONNECT_SESSION_UPDATE_AGE_SECONDS * 1000;

const grantSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("machine"),
    credentialHash: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  z.object({
    kind: z.literal("server"),
    credentialHash: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export type DesktopSessionGrant = z.infer<typeof grantSchema>;

const payloadSchema = z.object({
  typ: z.literal("desktop"),
  userId: z.string().min(1),
  grant: grantSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});

export interface DesktopSessionAccount {
  userId: string;
  grant: DesktopSessionGrant;
}

export interface DesktopSessionCookie {
  domain: string;
  expiresAt: number;
  name: string;
  value: string;
}

export interface IssueDesktopSessionOptions {
  key: PurposeKey;
  baseDomain: string;
  name: string;
}

export function issueDesktopSessionCookie(
  account: DesktopSessionAccount,
  options: IssueDesktopSessionOptions,
  now: number,
): DesktopSessionCookie {
  const expiresAt = now + DESKTOP_SESSION_TTL_MS;

  return {
    domain: `.${options.baseDomain}`,
    expiresAt,
    name: options.name,
    value: signToken(options.key, {
      typ: "desktop",
      userId: account.userId,
      grant: account.grant,
      iat: now,
      exp: expiresAt,
    }),
  };
}

export function desktopSessionSetCookie(
  cookie: DesktopSessionCookie,
  secure: boolean,
): string {
  return [
    `${cookie.name}=${cookie.value}`,
    `Domain=${cookie.domain}`,
    "Path=/",
    `Expires=${new Date(cookie.expiresAt).toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredDesktopSessionSetCookie(
  name: string,
  baseDomain: string,
  secure: boolean,
): string {
  return [
    `${name}=`,
    `Domain=.${baseDomain}`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export type VerifiedDesktopGrant =
  | { kind: "machine"; machineId: string; credentialHash: string }
  | { kind: "server"; serverId: string; credentialHash: string };

export interface VerifiedDesktopSession {
  userId: string;
  grant: VerifiedDesktopGrant;
  exp: number;
  needsRefresh: boolean;
}

export function resolveDesktopGrant(
  db: RelayDb,
  grant: DesktopSessionGrant,
): { userId: string; grant: VerifiedDesktopGrant } | null {
  if (grant.kind === "machine") {
    const row = liveMachineByHash(db, grant.credentialHash);

    return row === null
      ? null
      : {
          userId: row.userId,
          grant: {
            kind: "machine",
            machineId: row.machineId,
            credentialHash: grant.credentialHash,
          },
        };
  }

  const row = liveServerByHash(db, grant.credentialHash);

  return row === null
    ? null
    : {
        userId: row.userId,
        grant: {
          kind: "server",
          serverId: row.serverId,
          credentialHash: grant.credentialHash,
        },
      };
}

export function verifyDesktopSessionCookie(
  db: RelayDb,
  key: PurposeKey,
  value: string,
  now: number,
): VerifiedDesktopSession | null {
  const payload = verifyToken(key, value, payloadSchema);

  if (payload === null || payload.exp <= now) return null;
  const resolved = resolveDesktopGrant(db, payload.grant);

  if (resolved === null || resolved.userId !== payload.userId) return null;

  return {
    userId: payload.userId,
    grant: resolved.grant,
    exp: payload.exp,
    needsRefresh: now - payload.iat >= DESKTOP_SESSION_REFRESH_AFTER_MS,
  };
}
