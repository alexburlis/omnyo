import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { github as githubProvider } from "better-auth/social-providers";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  account,
  auditLog,
  CONNECT_SESSION_EXPIRES_IN_SECONDS,
  CONNECT_SESSION_UPDATE_AGE_SECONDS,
  session,
  user,
  verification,
} from "@omnyo/connect-db";
import {
  type GitHubConfig,
  isReservedTestDomain,
  reservedTestDomainList,
} from "../config.js";
import { CLIENT_IP_HEADER, type RelayLogger } from "../contracts.js";
import type { RelayDb } from "../db.js";
import { createJsonLogger } from "../log.js";
import { AUTH_COOKIE_ATTRIBUTES, AUTH_COOKIE_PREFIX } from "./cookies.js";
import {
  gitHubIdForUser,
  isGitHubAccountBlocked,
  isUserBlocked,
} from "../user-blocks.js";

export const AUTH_BASE_PATH = "/api/auth";

export const GITHUB_PROVIDER_ID = "github";

export const GITHUB_ACCOUNT_NOT_ALLOWED = "GITHUB_ACCOUNT_NOT_ALLOWED";

export const GITHUB_ACCOUNT_SUSPENDED = "GITHUB_ACCOUNT_SUSPENDED";

export const SIGNED_IN_ACTION = "auth.signed_in";

export const MAX_SESSIONS_PER_USER = 10;

export const MAX_SIGN_IN_RECORDS_PER_USER = 20;

export function githubNoReplyEmail(githubId: string, login: string): string {
  return `${githubId}+${login}@users.noreply.github.com`;
}

function suspendedError(): APIError {
  return new APIError("FORBIDDEN", {
    code: GITHUB_ACCOUNT_SUSPENDED,
    message: "This GitHub account is suspended on this relay",
  });
}

export class GitHubAllowlistRequiredError extends Error {
  constructor(hostname: string) {
    super(
      `GitHub sign-in on ${hostname} needs allowed GitHub user IDs; only ${reservedTestDomainList()} hosts may leave sign-up open`,
    );
    this.name = "GitHubAllowlistRequiredError";
  }
}

export interface RelayBetterAuthOptions {
  appUrl: string;
  secret: string;
  github: GitHubConfig;
  db: RelayDb;
}

function githubSignIn(
  github: GitHubConfig,
  appUrl: string,
  isBlocked: (githubId: string) => boolean,
) {
  const mapProfileToUser = (profile: {
    id: string | number;
    login: string;
  }) => ({
    githubLogin: profile.login,
    email: githubNoReplyEmail(String(profile.id), profile.login),
  });

  const base = {
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    overrideUserInfoOnSignIn: true,
    mapProfileToUser,
  };

  if (
    github.openSignUp !== true &&
    github.allowedUserIds === undefined &&
    !isReservedTestDomain(new URL(appUrl).hostname)
  ) {
    throw new GitHubAllowlistRequiredError(new URL(appUrl).hostname);
  }

  const allowed: ReadonlySet<string> | null =
    github.openSignUp === true || github.allowedUserIds === undefined
      ? null
      : new Set(github.allowedUserIds);

  const provider = githubProvider(base);

  return {
    ...base,
    getUserInfo: async (token: Parameters<typeof provider.getUserInfo>[0]) => {
      const info = await provider.getUserInfo(token);

      if (info === null) return null;
      const githubId = String(info.data.id);

      if (allowed !== null && !allowed.has(githubId)) {
        throw new APIError("FORBIDDEN", {
          code: GITHUB_ACCOUNT_NOT_ALLOWED,
          message: "This GitHub account may not sign in to this relay",
        });
      }

      if (isBlocked(githubId)) throw suspendedError();

      return info;
    },
  };
}

function recordSignIn(
  db: RelayDb,
  row: { userId: string; ipAddress?: string | null | undefined },
  at: Date,
): void {
  db.insert(auditLog)
    .values({
      id: randomUUID(),
      userId: row.userId,
      action: SIGNED_IN_ACTION,
      detail: JSON.stringify({ githubId: gitHubIdForUser(db, row.userId) }),
      ipAddress: row.ipAddress ?? null,
      createdAt: at,
    })
    .run();
  db.run(
    sql`DELETE FROM audit_log WHERE user_id = ${row.userId} AND action = ${SIGNED_IN_ACTION} AND id NOT IN (SELECT id FROM audit_log WHERE user_id = ${row.userId} AND action = ${SIGNED_IN_ACTION} ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_SIGN_IN_RECORDS_PER_USER})`,
  );
}

function keepNewestSessions(db: RelayDb, userId: string): void {
  db.run(
    sql`DELETE FROM session WHERE user_id = ${userId} AND id NOT IN (SELECT id FROM session WHERE user_id = ${userId} ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_SESSIONS_PER_USER})`,
  );
}

export const AUTH_LIBRARY_LOG_EVENT = "auth.library";

function libraryLogger(log: RelayLogger) {
  return {
    level: "warn" as const,
    log: (level: "debug" | "info" | "warn" | "error", message: string) => {
      const emit =
        level === "error" ? log.error : level === "warn" ? log.warn : log.info;

      emit(AUTH_LIBRARY_LOG_EVENT, { message });
    },
  };
}

export function createRelayBetterAuth(options: RelayBetterAuthOptions) {
  return betterAuth({
    logger: libraryLogger(
      createJsonLogger((line) => process.stdout.write(line)),
    ),
    appName: "Omnyo",
    secret: options.secret,
    baseURL: options.appUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [options.appUrl],
    database: drizzleAdapter(options.db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    session: {
      expiresIn: CONNECT_SESSION_EXPIRES_IN_SECONDS,
      updateAge: CONNECT_SESSION_UPDATE_AGE_SECONDS,
    },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      skipStateCookieCheck: false,
      storeStateStrategy: "database",
      encryptOAuthTokens: true,
    },
    user: {
      additionalFields: {
        githubLogin: { type: "string", required: false, input: true },
      },
    },
    socialProviders: {
      github: githubSignIn(options.github, options.appUrl, (githubId) =>
        isGitHubAccountBlocked(options.db, githubId),
      ),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (row) => {
            if (isUserBlocked(options.db, row.userId)) throw suspendedError();
          },
          after: async (row) => {
            if (isUserBlocked(options.db, row.userId)) {
              options.db.run(sql`DELETE FROM session WHERE id = ${row.id}`);

              throw suspendedError();
            }

            recordSignIn(options.db, row, row.createdAt);
            keepNewestSessions(options.db, row.userId);
          },
        },
      },
    },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: false,
      cookiePrefix: AUTH_COOKIE_PREFIX,
      defaultCookieAttributes: { ...AUTH_COOKIE_ATTRIBUTES },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}

export type RelayBetterAuth = ReturnType<typeof createRelayBetterAuth>;
