import {
  CONNECT_SESSION_EXPIRES_IN_SECONDS,
  CONNECT_SESSION_UPDATE_AGE_SECONDS,
} from "@omnyo/connect-db";
import { z } from "zod";
import { GATE_COOKIE, hostCookie } from "./cookies.js";
import { type PurposeKey, signToken, verifyToken } from "./signed-token.js";

export const GATE_COOKIE_MAX_AGE_MS = CONNECT_SESSION_EXPIRES_IN_SECONDS * 1000;

export const GATE_COOKIE_REISSUE_AFTER_MS =
  CONNECT_SESSION_UPDATE_AGE_SECONDS * 1000;

const payloadSchema = z.object({
  typ: z.literal("gate"),
  userId: z.string().min(1),
  host: z.string().min(1),
  grant: z.object({
    kind: z.literal("session"),
    sessionId: z.string().min(1),
  }),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type GateCookiePayload = z.infer<typeof payloadSchema>;

export interface GateCookieInput {
  userId: string;
  host: string;
  sessionId: string;
  sessionExpiresAt: number;
}

export function issueGateCookie(
  key: PurposeKey,
  input: GateCookieInput,
  now: number,
): { setCookie: string; payload: GateCookiePayload } {
  const payload: GateCookiePayload = {
    typ: "gate",
    userId: input.userId,
    host: input.host,
    grant: { kind: "session", sessionId: input.sessionId },
    iat: now,
    exp: Math.min(input.sessionExpiresAt, now + GATE_COOKIE_MAX_AGE_MS),
  };

  return {
    payload,
    setCookie: hostCookie({
      name: GATE_COOKIE,
      value: signToken(key, payload),
      expiresAt: payload.exp,
    }),
  };
}

export function readGateCookie(
  key: PurposeKey,
  value: string,
  host: string,
  now: number,
): GateCookiePayload | null {
  const payload = verifyToken(key, value, payloadSchema);

  if (payload === null || payload.exp <= now) return null;

  return payload.host === host ? payload : null;
}
