import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ConnectDb } from "@omnyo/connect-db";
import type { RelayDb } from "./db.js";

export const SUSPENDED_ACTION = "operator.suspended";

export const UNSUSPENDED_ACTION = "operator.unsuspended";

export const DELETED_ACTION = "operator.deleted_user";

export type RelaySql = Pick<RelayDb, "run" | "get" | "all">;

export function gitHubIdForUser(db: RelaySql, userId: string): string | null {
  return (
    db.get<{ github_id: string } | undefined>(
      sql`SELECT account_id AS github_id FROM account WHERE user_id = ${userId} AND provider_id = 'github' ORDER BY created_at LIMIT 1`,
    )?.github_id ?? null
  );
}

function userIdForGitHubId(db: RelaySql, githubId: string): string | null {
  return (
    db.get<{ user_id: string } | undefined>(
      sql`SELECT user_id FROM account WHERE provider_id = 'github' AND account_id = ${githubId} ORDER BY created_at LIMIT 1`,
    )?.user_id ?? null
  );
}

function blockedUserQuery(userId: string) {
  return sql`SELECT 1 AS blocked FROM relay_suspension WHERE user_id = ${userId} OR github_id IN (SELECT account_id FROM account WHERE user_id = ${userId} AND provider_id = 'github') LIMIT 1`;
}

export function isUserBlocked(db: RelaySql, userId: string): boolean {
  return db.get(blockedUserQuery(userId)) !== undefined;
}

export async function isAccountSuspended(
  db: ConnectDb,
  userId: string,
): Promise<boolean> {
  return (await db.get(blockedUserQuery(userId))) !== undefined;
}

export function isGitHubAccountBlocked(
  db: RelaySql,
  githubId: string,
): boolean {
  return (
    db.get(
      sql`SELECT 1 AS blocked FROM relay_suspension WHERE github_id = ${githubId} OR user_id IN (SELECT user_id FROM account WHERE provider_id = 'github' AND account_id = ${githubId}) LIMIT 1`,
    ) !== undefined
  );
}

export type OperatorTarget =
  | { kind: "label"; label: string }
  | { kind: "github-id"; githubId: string };

export type TargetMatch =
  | "handle"
  | "server address"
  | "device address"
  | "retired address"
  | "GitHub ID";

export interface ResolvedAccount {
  userId: string | null;
  githubId: string | null;
  githubLogin: string | null;
  handle: string | null;
  matchedBy: TargetMatch;
}

const MATCH_FOR_CLAIM_KIND: Readonly<Record<string, TargetMatch>> = {
  handle: "handle",
  server: "server address",
  machine: "device address",
};

function existingUserId(db: RelaySql, userId: string): string | null {
  return db.get(sql`SELECT 1 AS present FROM user WHERE id = ${userId}`) ===
    undefined
    ? null
    : userId;
}

function describedAccount(
  db: RelaySql,
  input: {
    userId: string | null;
    githubId: string | null;
    matchedBy: TargetMatch;
  },
): ResolvedAccount {
  const details =
    input.userId === null
      ? undefined
      : db.get<
          { github_login: string | null; handle: string | null } | undefined
        >(
          sql`SELECT u.github_login AS github_login, p.handle AS handle FROM user u LEFT JOIN profile p ON p.user_id = u.id WHERE u.id = ${input.userId}`,
        );

  return {
    userId: input.userId,
    githubId:
      input.githubId ??
      (input.userId === null ? null : gitHubIdForUser(db, input.userId)),
    githubLogin: details?.github_login ?? null,
    handle: details?.handle ?? null,
    matchedBy: input.matchedBy,
  };
}

export function resolveOperatorTarget(
  db: RelaySql,
  target: OperatorTarget,
): ResolvedAccount | null {
  if (target.kind === "github-id") {
    return describedAccount(db, {
      userId: userIdForGitHubId(db, target.githubId),
      githubId: target.githubId,
      matchedBy: "GitHub ID",
    });
  }

  const label = target.label.trim().toLowerCase();

  const claim = db.get<{ kind: string; user_id: string } | undefined>(
    sql`SELECT kind, user_id FROM label_claim WHERE label = ${label}`,
  );

  if (claim !== undefined) {
    return describedAccount(db, {
      userId: claim.user_id,
      githubId: null,
      matchedBy: MATCH_FOR_CLAIM_KIND[claim.kind] ?? "server address",
    });
  }

  const retired = db.get<
    { github_id: string | null; user_id: string } | undefined
  >(
    sql`SELECT github_id, user_id FROM relay_retired_label WHERE label = ${label}`,
  );

  if (retired === undefined) return null;

  return describedAccount(db, {
    userId:
      existingUserId(db, retired.user_id) ??
      (retired.github_id === null
        ? null
        : userIdForGitHubId(db, retired.github_id)),
    githubId: retired.github_id,
    matchedBy: "retired address",
  });
}

export function describeAccount(account: ResolvedAccount): string {
  const handle = account.handle ?? "none";
  const login = account.githubLogin ?? "unknown";
  const githubId = account.githubId ?? "unknown";
  const user = account.userId === null ? ", no relay user" : "";

  return `handle ${handle}, GitHub login ${login}, GitHub ID ${githubId}${user} (matched by ${account.matchedBy})`;
}

export interface RevokedServer {
  id: string;
  credentialHash: string | null;
}

export interface LiveCredentials {
  servers: RevokedServer[];
  machines: string[];
}

export function liveCredentialsOf(
  db: RelaySql,
  userId: string,
): LiveCredentials {
  return {
    servers: db
      .all<{ id: string; credential_hash: string | null }>(
        sql`SELECT id, credential_hash FROM server WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY id`,
      )
      .map((row) => ({ id: row.id, credentialHash: row.credential_hash })),
    machines: db
      .all<{ id: string }>(
        sql`SELECT id FROM machine WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY id`,
      )
      .map((row) => row.id),
  };
}

function auditDetail(fields: Record<string, string | null>): string {
  return JSON.stringify(fields);
}

function audit(
  db: RelaySql,
  input: {
    userId: string | null;
    action: string;
    detail: string;
    at: number;
  },
): void {
  db.run(
    sql`INSERT INTO audit_log (id, user_id, action, detail, ip_address, created_at) VALUES (${randomUUID()}, ${input.userId}, ${input.action}, ${input.detail}, NULL, ${input.at})`,
  );
}

export interface SuspensionSubject {
  userId: string | null;
  githubId: string | null;
}

export function restoreSuspension(
  db: RelaySql,
  input: SuspensionSubject & { reason: string | null; at: number },
): boolean {
  if (input.githubId === null && input.userId === null) return false;

  const existing = db.get(
    sql`SELECT 1 AS present FROM relay_suspension WHERE github_id = ${input.githubId} OR user_id = ${input.userId}`,
  );

  if (existing !== undefined) return false;
  db.run(
    sql`INSERT INTO relay_suspension (github_id, user_id, blocked_at, reason) VALUES (${input.githubId}, ${input.userId}, ${input.at}, ${input.reason})`,
  );

  return true;
}

export function liftSuspension(
  db: RelaySql,
  input: SuspensionSubject,
): boolean {
  return (
    db.run(
      sql`DELETE FROM relay_suspension WHERE github_id = ${input.githubId} OR user_id = ${input.userId} OR (${input.userId} IS NOT NULL AND github_id IN (SELECT account_id FROM account WHERE user_id = ${input.userId} AND provider_id = 'github'))`,
    ).changes > 0
  );
}

const NO_CREDENTIALS: LiveCredentials = { servers: [], machines: [] };

interface EndedAccess {
  revoked: LiveCredentials;
  sessions: number;
  codes: number;
}

function endAccountAccess(
  db: RelaySql,
  userId: string,
  now: number,
): EndedAccess {
  const revoked = liveCredentialsOf(db, userId);

  db.run(
    sql`UPDATE server SET credential_hash = NULL, revoked_at = ${now} WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );
  db.run(
    sql`UPDATE machine SET revoked_at = ${now} WHERE user_id = ${userId} AND revoked_at IS NULL`,
  );

  const sessions = db.run(
    sql`DELETE FROM session WHERE user_id = ${userId}`,
  ).changes;

  const codes = db.run(
    sql`DELETE FROM connect_code WHERE user_id = ${userId} OR server_id IN (SELECT id FROM server WHERE user_id = ${userId})`,
  ).changes;

  return { revoked, sessions, codes };
}

export interface SuspendedUser {
  githubId: string | null;
  servers: number;
  machines: number;
  sessions: number;
  codes: number;
  revoked: LiveCredentials;
}

export function suspendAccount(
  db: RelayDb,
  input: SuspensionSubject & { reason: string | null; now: number },
): SuspendedUser {
  const githubId =
    input.githubId ??
    (input.userId === null ? null : gitHubIdForUser(db, input.userId));

  if (githubId === null && input.userId === null) {
    throw new Error("a suspension needs a relay user or a GitHub ID");
  }

  return db.transaction((tx) => {
    liftSuspension(tx, { githubId, userId: input.userId });
    tx.run(
      sql`INSERT INTO relay_suspension (github_id, user_id, blocked_at, reason) VALUES (${githubId}, ${input.userId}, ${input.now}, ${input.reason})`,
    );

    const { revoked, sessions, codes } =
      input.userId === null
        ? { revoked: NO_CREDENTIALS, sessions: 0, codes: 0 }
        : endAccountAccess(tx, input.userId, input.now);

    audit(tx, {
      userId: input.userId,
      action: SUSPENDED_ACTION,
      detail: auditDetail({ githubId, reason: input.reason }),
      at: input.now,
    });

    return {
      githubId,
      servers: revoked.servers.length,
      machines: revoked.machines.length,
      sessions,
      codes,
      revoked,
    };
  });
}

export function suspendUser(
  db: RelayDb,
  input: { userId: string; reason: string | null; now: number },
): SuspendedUser {
  return suspendAccount(db, {
    userId: input.userId,
    githubId: null,
    reason: input.reason,
    now: input.now,
  });
}

export function unsuspendAccount(
  db: RelayDb,
  input: SuspensionSubject & { now: number },
): LiveCredentials | null {
  return db.transaction((tx) => {
    if (!liftSuspension(tx, input)) return null;

    const { revoked } =
      input.userId === null
        ? { revoked: NO_CREDENTIALS }
        : endAccountAccess(tx, input.userId, input.now);

    audit(tx, {
      userId: input.userId,
      action: UNSUSPENDED_ACTION,
      detail: auditDetail({
        githubId:
          input.githubId ??
          (input.userId === null ? null : gitHubIdForUser(tx, input.userId)),
      }),
      at: input.now,
    });

    return revoked;
  });
}

export function unsuspendUser(
  db: RelayDb,
  input: { userId: string; now: number },
): boolean {
  return (
    unsuspendAccount(db, {
      userId: input.userId,
      githubId: null,
      now: input.now,
    }) !== null
  );
}

export function retireLabelsOf(
  db: RelaySql,
  input: { userId: string; githubId: string | null; at: number },
): void {
  db.run(
    sql`INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) SELECT label, kind, ${input.githubId}, user_id, ${input.at} FROM label_claim WHERE user_id = ${input.userId} ON CONFLICT (label) DO UPDATE SET github_id = COALESCE(relay_retired_label.github_id, excluded.github_id), user_id = excluded.user_id, retired_at = excluded.retired_at`,
  );
}

export function deleteUserRows(
  db: RelaySql,
  input: { userId: string; at: number },
): { deleted: boolean; githubId: string | null } {
  const githubId = gitHubIdForUser(db, input.userId);
  retireLabelsOf(db, { userId: input.userId, githubId, at: input.at });

  if (githubId !== null) {
    db.run(
      sql`UPDATE relay_suspension SET github_id = ${githubId} WHERE user_id = ${input.userId} AND github_id IS NULL`,
    );
  }

  const deleted =
    db.run(sql`DELETE FROM user WHERE id = ${input.userId}`).changes > 0;

  return { deleted, githubId };
}

export function deleteRelayUser(
  db: RelayDb,
  input: { userId: string; now: number },
): boolean {
  return db.transaction((tx) => {
    const { deleted, githubId } = deleteUserRows(tx, {
      userId: input.userId,
      at: input.now,
    });

    if (deleted) {
      audit(tx, {
        userId: null,
        action: DELETED_ACTION,
        detail: auditDetail({ githubId }),
        at: input.now,
      });
    }

    return deleted;
  });
}
