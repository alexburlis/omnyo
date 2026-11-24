import { and, eq, gt, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import {
  auditLog,
  connectCode,
  machine,
  profile,
  server,
  session,
  user,
  verification,
} from "@omnyo/connect-db";
import { LINK_EXPIRED_ROW_RETENTION_MS } from "./account/account.js";
import type { RelayLogger } from "./contracts.js";
import type { RelayDb } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const AUDIT_LOG_RETENTION_MS = 90 * DAY_MS;

export const BEARER_REJECTED_ACTION = "gate.bearer_rejected";

export const ANONYMOUS_REJECTION_RETENTION_MS = 7 * DAY_MS;

export const REVOKED_MACHINE_RETENTION_MS = 30 * DAY_MS;

export const INACTIVE_USER_RETENTION_MS = 30 * DAY_MS;

export interface PruneResult {
  verifications: number;
  connectCodes: number;
  auditRows: number;
  sessions: number;
  revokedMachines: number;
  inactiveUsers: number;
  workflowShares: number;
}

const ONE = sql`1`;

export function pruneExpiredRows(db: RelayDb, now: number): PruneResult {
  return db.transaction((tx) => {
    const verifications = tx
      .delete(verification)
      .where(lte(verification.expiresAt, new Date(now)))
      .run().changes;

    const connectCodes = tx
      .delete(connectCode)
      .where(
        lt(
          connectCode.expiresAt,
          new Date(now - LINK_EXPIRED_ROW_RETENTION_MS),
        ),
      )
      .run().changes;

    const auditRows =
      tx
        .delete(auditLog)
        .where(lt(auditLog.createdAt, new Date(now - AUDIT_LOG_RETENTION_MS)))
        .run().changes +
      tx
        .delete(auditLog)
        .where(
          and(
            eq(auditLog.action, BEARER_REJECTED_ACTION),
            isNull(auditLog.userId),
            lt(
              auditLog.createdAt,
              new Date(now - ANONYMOUS_REJECTION_RETENTION_MS),
            ),
          ),
        )
        .run().changes;

    const sessions = tx
      .delete(session)
      .where(lte(session.expiresAt, new Date(now)))
      .run().changes;

    const workflowShares = tx.run(
      sql`DELETE FROM relay_workflow_share WHERE expires_at <= ${now}`,
    ).changes;

    const revokedMachines = tx
      .delete(machine)
      .where(
        lt(machine.revokedAt, new Date(now - REVOKED_MACHINE_RETENTION_MS)),
      )
      .run().changes;

    const inactiveUsers = tx
      .delete(user)
      .where(
        and(
          lt(user.createdAt, new Date(now - INACTIVE_USER_RETENTION_MS)),
          notExists(
            tx
              .select({ one: ONE })
              .from(profile)
              .where(eq(profile.userId, user.id)),
          ),
          notExists(
            tx
              .select({ one: ONE })
              .from(server)
              .where(eq(server.userId, user.id)),
          ),
          notExists(
            tx
              .select({ one: ONE })
              .from(machine)
              .where(eq(machine.userId, user.id)),
          ),
          notExists(
            tx
              .select({ one: ONE })
              .from(session)
              .where(
                and(
                  eq(session.userId, user.id),
                  gt(session.expiresAt, new Date(now)),
                ),
              ),
          ),
          sql`NOT EXISTS (SELECT 1 FROM relay_workflow_share WHERE relay_workflow_share.user_id = ${user.id} AND relay_workflow_share.expires_at > ${now})`,
        ),
      )
      .run().changes;

    return {
      verifications,
      connectCodes,
      auditRows,
      sessions,
      revokedMachines,
      inactiveUsers,
      workflowShares,
    };
  });
}

export function startPruneJob(input: {
  db: RelayDb;
  log: RelayLogger;
  now: () => number;
  intervalMs?: number;
}): () => void {
  const run = () => {
    try {
      const result = pruneExpiredRows(input.db, input.now());
      input.log.info("relay.pruned", { ...result });
    } catch (error) {
      input.log.error("relay.prune_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  };

  run();
  const timer = setInterval(run, input.intervalMs ?? PRUNE_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
