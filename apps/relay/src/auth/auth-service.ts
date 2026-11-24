import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import {
  CONNECT_SESSION_EXPIRES_IN_SECONDS,
  CONNECT_SESSION_UPDATE_AGE_SECONDS,
  session,
  user,
} from "@omnyo/connect-db";
import {
  type AuthenticatedSession,
  type AuthService,
  CLIENT_IP_HEADER,
  type RelaySession,
  type RelayUser,
} from "../contracts.js";
import type { RelayDb } from "../db.js";
import {
  AUTH_BASE_PATH,
  GITHUB_PROVIDER_ID,
  type RelayBetterAuth,
} from "./better-auth.js";
import { SESSION_COOKIE_NAME } from "./cookies.js";

export const SESSION_EXPIRES_IN_MS = CONNECT_SESSION_EXPIRES_IN_SECONDS * 1000;

export const SESSION_UPDATE_AGE_MS = CONNECT_SESSION_UPDATE_AGE_SECONDS * 1000;

const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  `GET ${AUTH_BASE_PATH}/callback/${GITHUB_PROVIDER_ID}`,
  `POST ${AUTH_BASE_PATH}/sign-out`,
  `GET ${AUTH_BASE_PATH}/error`,
  `GET ${AUTH_BASE_PATH}/ok`,
]);

const UNSAFE_PATH_CHARACTERS = /[\u0000- \u007f\\]/u;

const sessionResponseSchema = z.object({
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullish(),
    githubLogin: z.string().nullish(),
  }),
});

const signInResponseSchema = z.object({ url: z.url() });

export interface ResolvedApexSession extends AuthenticatedSession {
  setCookies: string[];
}

export interface RelayAuthService extends AuthService {
  resolveSession(headers: Headers): Promise<ResolvedApexSession | null>;
  startGitHubSignIn(headers: Headers, callbackPath: string): Promise<Response>;
  signOut(headers: Headers, redirectPath: string): Promise<Response>;
}

export class AuthFlowError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthFlowError";
    this.status = status;
  }
}

export function isAllowedAuthRoute(method: string, pathname: string): boolean {
  return ALLOWED_AUTH_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

export function safeAppPath(raw: string, appUrl: string): string | null {
  if (raw === "" || !raw.startsWith("/") || raw.startsWith("//")) return null;

  let decoded: string;

  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (UNSAFE_PATH_CHARACTERS.test(raw) || UNSAFE_PATH_CHARACTERS.test(decoded))
    return null;

  let resolved: URL;

  try {
    resolved = new URL(raw, appUrl);
  } catch {
    return null;
  }

  if (
    resolved.origin !== new URL(appUrl).origin ||
    resolved.pathname.startsWith("//")
  ) {
    return null;
  }

  return `${resolved.pathname}${resolved.search}`;
}

function toRelaySession(row: typeof session.$inferSelect): RelaySession {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

function toRelayUser(row: typeof user.$inferSelect): RelayUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image ?? null,
    githubLogin: row.githubLogin ?? null,
  };
}

function sessionCookieCount(cookieHeader: string): number {
  return cookieHeader
    .split(";")
    .filter((pair) => pair.split("=", 1)[0]?.trim() === SESSION_COOKIE_NAME)
    .length;
}

function internalHeaders(source: Headers, appUrl: string): Headers {
  const headers = new Headers();
  const cookie = source.get("cookie");
  const clientIp = source.get(CLIENT_IP_HEADER);

  if (cookie !== null) headers.set("cookie", cookie);

  if (clientIp !== null) headers.set(CLIENT_IP_HEADER, clientIp);
  headers.set("origin", new URL(appUrl).origin);

  return headers;
}

function redirectWithCookies(location: string, setCookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });

  for (const value of setCookies) headers.append("set-cookie", value);

  return new Response(null, { status: 302, headers });
}

export interface AuthServiceOptions {
  auth: RelayBetterAuth;
  db: RelayDb;
  appUrl: string;
}

export function createAuthService(
  options: AuthServiceOptions,
): RelayAuthService {
  const { auth, db } = options;
  const appOrigin = new URL(options.appUrl).origin;

  function authUrl(path: string): URL {
    return new URL(`${AUTH_BASE_PATH}${path}`, appOrigin);
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (!isAllowedAuthRoute(request.method, url.pathname)) {
      return Response.json({ error: "not-found" }, { status: 404 });
    }

    return auth.handler(request);
  }

  async function resolveSession(
    headers: Headers,
  ): Promise<ResolvedApexSession | null> {
    const cookieHeader = headers.get("cookie");

    if (cookieHeader === null || sessionCookieCount(cookieHeader) > 1)
      return null;
    const url = authUrl("/get-session");
    url.searchParams.set("disableCookieCache", "true");

    const response = await auth.handler(
      new Request(url, { headers: internalHeaders(headers, appOrigin) }),
    );

    if (!response.ok) {
      throw new AuthFlowError(
        `session lookup failed (${response.status})`,
        response.status,
      );
    }

    const body: unknown = await response.json();

    if (body === null) return null;
    const parsed = sessionResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new AuthFlowError("session lookup returned an invalid body", 500);
    }

    return {
      session: parsed.data.session,
      user: {
        id: parsed.data.user.id,
        name: parsed.data.user.name,
        email: parsed.data.user.email,
        image: parsed.data.user.image ?? null,
        githubLogin: parsed.data.user.githubLogin ?? null,
      },
      setCookies: response.headers.getSetCookie(),
    };
  }

  async function getSession(
    headers: Headers,
  ): Promise<AuthenticatedSession | null> {
    const resolved = await resolveSession(headers);

    return resolved === null
      ? null
      : { session: resolved.session, user: resolved.user };
  }

  async function startGitHubSignIn(
    headers: Headers,
    callbackPath: string,
  ): Promise<Response> {
    const callback = safeAppPath(callbackPath, appOrigin);

    if (callback === null) {
      throw new AuthFlowError("sign-in callback must be an app path", 400);
    }

    const requestHeaders = internalHeaders(headers, appOrigin);
    requestHeaders.delete("cookie");
    requestHeaders.set("content-type", "application/json");

    const response = await auth.handler(
      new Request(authUrl("/sign-in/social"), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          provider: GITHUB_PROVIDER_ID,
          callbackURL: callback,
          errorCallbackURL: "/dashboard",
        }),
      }),
    );

    if (!response.ok) {
      throw new AuthFlowError(
        `sign-in start failed (${response.status})`,
        response.status,
      );
    }

    const parsed = signInResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new AuthFlowError("sign-in start returned no URL", 500);
    }

    return redirectWithCookies(
      parsed.data.url,
      response.headers.getSetCookie(),
    );
  }

  async function signOut(
    headers: Headers,
    redirectPath: string,
  ): Promise<Response> {
    const target = safeAppPath(redirectPath, appOrigin);

    if (target === null) {
      throw new AuthFlowError("sign-out redirect must be an app path", 400);
    }

    const response = await auth.handler(
      new Request(authUrl("/sign-out"), {
        method: "POST",
        headers: internalHeaders(headers, appOrigin),
      }),
    );

    if (!response.ok) {
      throw new AuthFlowError(
        `sign-out failed (${response.status})`,
        response.status,
      );
    }

    return redirectWithCookies(
      new URL(target, appOrigin).toString(),
      response.headers.getSetCookie(),
    );
  }

  function findLiveSession(
    sessionId: string,
    now: number,
  ): RelaySession | null {
    const row = db
      .select()
      .from(session)
      .where(
        and(eq(session.id, sessionId), gt(session.expiresAt, new Date(now))),
      )
      .get();

    return row === undefined ? null : toRelaySession(row);
  }

  function findUser(userId: string): RelayUser | null {
    const row = db.select().from(user).where(eq(user.id, userId)).get();

    return row === undefined ? null : toRelayUser(row);
  }

  function renewSession(sessionId: string, now: number): RelaySession | null {
    const live = findLiveSession(sessionId, now);

    if (live === null) return null;

    if (now - live.updatedAt.getTime() < SESSION_UPDATE_AGE_MS) return live;

    db.update(session)
      .set({
        expiresAt: new Date(now + SESSION_EXPIRES_IN_MS),
        updatedAt: new Date(now),
      })
      .where(
        and(eq(session.id, sessionId), gt(session.expiresAt, new Date(now))),
      )
      .run();

    return findLiveSession(sessionId, now);
  }

  return {
    handler,
    getSession,
    resolveSession,
    startGitHubSignIn,
    signOut,
    findLiveSession,
    findUser,
    renewSession,
  };
}
