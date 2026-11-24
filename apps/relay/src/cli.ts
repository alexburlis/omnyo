import { sql } from "drizzle-orm";
import { revokeWorkflowShare, WORKFLOW_SHARE_ID } from "./workflow-shares.js";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { auditLog, validateLabel } from "@omnyo/connect-db";
import { BACKUP_DIRECTORY, createRelayBackup } from "./backup.js";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import {
  createRevocationJournal,
  revocationJournalPath,
  type RevocationJournalInput,
} from "./gate/revocation.js";
import type { MigrationDirectories } from "./migrations.js";
import {
  brokenRelayLabelRule,
  isRelayReservedLabel,
  labelWriteRefusal,
  RELAY_LABEL_LIMIT_PER_ACCOUNT,
  relayLabelProblem,
  type RelayLabelRule,
} from "./reserved-labels.js";
import {
  deleteRelayUser,
  describeAccount,
  liveCredentialsOf,
  type OperatorTarget,
  type ResolvedAccount,
  resolveOperatorTarget,
  suspendAccount,
  unsuspendAccount,
} from "./user-blocks.js";

export const BACKUP_COMMAND = "backup";

export const AUDIT_TAIL_COMMAND = "audit-tail";

export const SUSPEND_COMMAND = "suspend";

export const UNSUSPEND_COMMAND = "unsuspend";

export const DELETE_USER_COMMAND = "delete-user";

export const LABEL_VIOLATIONS_COMMAND = "label-violations";

export const RENAME_LABEL_COMMAND = "rename-label";

export const RETIRE_LABELS_FROM_COMMAND = "retire-labels-from";

export const VACUUM_COMMAND = "vacuum";

export const VACUUM_BUSY_TIMEOUT_MS = 5000;

export const AUDIT_TAIL_DEFAULT_LIMIT = 20;

export const AUDIT_TAIL_MAX_LIMIT = 1000;

export const COMMAND_USAGE = [
  `usage: node dist/main.js ${BACKUP_COMMAND}`,
  "       node dist/main.js revoke-workflow-share <share-id>",
  `       node dist/main.js ${VACUUM_COMMAND}`,
  `       node dist/main.js ${AUDIT_TAIL_COMMAND} [--limit N] [--action NAME]`,
  `       node dist/main.js ${SUSPEND_COMMAND} <address> | --github-id N [--reason TEXT]`,
  `       node dist/main.js ${UNSUSPEND_COMMAND} <address> | --github-id N`,
  `       node dist/main.js ${DELETE_USER_COMMAND} <address> | --github-id N [--yes]`,
  `       node dist/main.js ${LABEL_VIOLATIONS_COMMAND}`,
  `       node dist/main.js ${RENAME_LABEL_COMMAND} <old-address> <new-address>`,
  `       node dist/main.js ${RETIRE_LABELS_FROM_COMMAND} <older-database-copy>`,
  "<address> is a handle, server label or device label: alice for alice.omnyo.link",
  `${DELETE_USER_COMMAND} without --yes prints the account it would delete and changes nothing`,
].join("\n");

export const COMMAND_FAILED_EXIT_CODE = 1;

export const COMMAND_USAGE_EXIT_CODE = 64;

const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

const ADDRESS_LABEL = /^[a-z0-9-]+$/u;

const IN_MEMORY_DATABASE = ":memory:";

export interface RelayCommandIo {
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<string | Uint8Array>;
  stdinIsTerminal: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  migrations: MigrationDirectories;
}

function usage(io: RelayCommandIo, problem: string): number {
  io.stderr(`${problem}\n${COMMAND_USAGE}\n`);

  return COMMAND_USAGE_EXIT_CODE;
}

function fail(io: RelayCommandIo, command: string, problem: string): number {
  io.stderr(`${command}: ${problem}\n`);

  return COMMAND_FAILED_EXIT_CODE;
}

function revokeShare(args: readonly string[], io: RelayCommandIo): number {
  const [id] = args;

  if (args.length !== 1 || !id || !WORKFLOW_SHARE_ID.test(id))
    return usage(io, "Expected a workflow share ID");
  const path = databasePathFrom(io);

  if (!path)
    return fail(
      io,
      "revoke-workflow-share",
      "DATABASE_PATH must name the relay database file",
    );

  try {
    const database = openRelayDatabase(path, io.migrations);

    try {
      const row = database.db.get<{ user_id: string }>(
        sql`SELECT user_id FROM relay_workflow_share WHERE id = ${id}`,
      );

      if (!row) return fail(io, "revoke-workflow-share", "Share not found");
      const journal = createRevocationJournal(revocationJournalPath(path));
      revokeWorkflowShare(database.db, (entry) => journal.append(entry), {
        id,
        userId: row.user_id,
        now: Date.now(),
      });
      io.stdout("Workflow share revoked. Downloaded copies are unaffected.\n");

      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(io, "revoke-workflow-share", failureSummary(error));
  }
}

function databasePathFrom(io: RelayCommandIo): string | null {
  const path = io.env.DATABASE_PATH?.trim();

  return path === undefined || path === "" || path === IN_MEMORY_DATABASE
    ? null
    : path;
}

function failureSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  const [firstLine] = error.message.split("\n");

  return firstLine === undefined || firstLine === ""
    ? error.name
    : `${error.name}: ${firstLine}`;
}

function openReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function backup(args: readonly string[], io: RelayCommandIo): number {
  if (args.length > 0) return usage(io, `${BACKUP_COMMAND} takes no arguments`);
  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      BACKUP_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  try {
    const sqlite = openReadonly(path);

    try {
      const file = createRelayBackup({
        sqlite,
        directory: join(dirname(path), BACKUP_DIRECTORY),
        now: Date.now(),
        truncateWal: false,
      });

      io.stdout(`${file} ok\n`);

      return 0;
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return fail(io, BACKUP_COMMAND, failureSummary(error));
  }
}

function vacuum(args: readonly string[], io: RelayCommandIo): number {
  if (args.length > 0) return usage(io, `${VACUUM_COMMAND} takes no arguments`);
  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      VACUUM_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  try {
    const database = openRelayDatabase(path, io.migrations);

    try {
      database.sqlite.pragma(`busy_timeout = ${VACUUM_BUSY_TIMEOUT_MS}`);
      database.sqlite.pragma("temp_store = FILE");
      const before = statSync(path).size;

      database.sqlite.exec("VACUUM");

      if (!walTruncated(database.sqlite)) {
        return fail(
          io,
          VACUUM_COMMAND,
          `another connection is reading the database, so the write-ahead log still holds old pages until the relay's next checkpoint (${before} bytes before, ${statSync(path).size} bytes after); run ${VACUUM_COMMAND} again`,
        );
      }

      io.stdout(
        `${VACUUM_COMMAND} ok: ${before} bytes before, ${statSync(path).size} bytes after\n`,
      );

      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(io, VACUUM_COMMAND, failureSummary(error));
  }
}

interface AuditTailOptions {
  limit: number;
  action: string | null;
}

function parseAuditTailArgs(args: readonly string[]): AuditTailOptions | null {
  let values: { limit?: string; action?: string };

  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { limit: { type: "string" }, action: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return null;
  }

  const limitText = values.limit ?? String(AUDIT_TAIL_DEFAULT_LIMIT);

  if (!POSITIVE_INTEGER.test(limitText)) return null;
  const limit = Number(limitText);

  if (limit > AUDIT_TAIL_MAX_LIMIT) return null;

  if (values.action === "") return null;

  return { limit, action: values.action ?? null };
}

function auditTail(args: readonly string[], io: RelayCommandIo): number {
  const options = parseAuditTailArgs(args);

  if (options === null) {
    return usage(
      io,
      `--limit must be an integer from 1 to ${AUDIT_TAIL_MAX_LIMIT} and --action must name an action`,
    );
  }

  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      AUDIT_TAIL_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  let lines: string[];

  try {
    const sqlite = openReadonly(path);

    try {
      const rows = drizzle(sqlite)
        .select({
          createdAt: auditLog.createdAt,
          action: auditLog.action,
          ipAddress: auditLog.ipAddress,
        })
        .from(auditLog)
        .where(
          options.action === null
            ? undefined
            : eq(auditLog.action, options.action),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(options.limit)
        .all();

      lines = rows.map((row) =>
        JSON.stringify({
          created_at: row.createdAt.toISOString(),
          action: row.action,
          ip_address: row.ipAddress,
        }),
      );
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return fail(io, AUDIT_TAIL_COMMAND, failureSummary(error));
  }

  if (lines.length > 0) io.stdout(`${lines.join("\n")}\n`);

  return 0;
}

const SUSPENSION_REASON_MAX_LENGTH = 500;

interface AccountCommandArgs {
  target: OperatorTarget;
  reason: string | null;
  yes: boolean;
}

function parseAccountCommandArgs(
  args: readonly string[],
  allowed: { reason: boolean; yes: boolean },
): AccountCommandArgs | null {
  let values: { reason?: string; yes?: boolean; "github-id"?: string };
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      options: {
        reason: { type: "string" },
        yes: { type: "boolean" },
        "github-id": { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch {
    return null;
  }

  if (!allowed.reason && values.reason !== undefined) return null;

  if (!allowed.yes && values.yes !== undefined) return null;
  const githubId = values["github-id"]?.trim();

  if (positionals.length > 1) return null;
  const [rawLabel] = positionals;
  const label = rawLabel?.trim().toLowerCase();

  let target: OperatorTarget;

  if (githubId !== undefined) {
    if (label !== undefined || !POSITIVE_INTEGER.test(githubId)) return null;
    target = { kind: "github-id", githubId };
  } else {
    if (label === undefined || !ADDRESS_LABEL.test(label)) return null;
    target = { kind: "label", label };
  }

  return {
    target,
    reason:
      values.reason?.trim().slice(0, SUSPENSION_REASON_MAX_LENGTH) || null,
    yes: values.yes === true,
  };
}

function targetUsage(command: string, extra: string): string {
  return `${command} takes one address (a handle, server label or device label) or --github-id N${extra}`;
}

type AccountOutcome =
  | {
      ok: true;
      message: string;
      journal: RevocationJournalInput[];
      truncateLog?: boolean;
    }
  | { ok: false; problem: string };

class JournalWriteError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(failureSummary(cause));
    this.name = "JournalWriteError";
  }
}

function withAccount(
  io: RelayCommandIo,
  command: string,
  target: OperatorTarget,
  act: (database: RelayDatabase, account: ResolvedAccount) => AccountOutcome,
): number {
  const path = databasePathFrom(io);

  if (path === null) {
    return fail(io, command, "DATABASE_PATH must name the relay database file");
  }

  let outcome: AccountOutcome;
  let message: string;
  const journalPath = revocationJournalPath(path);

  try {
    const database = openRelayDatabase(path, io.migrations);

    try {
      const account = resolveOperatorTarget(database.db, target);

      if (account === null) {
        return fail(
          io,
          command,
          target.kind === "label"
            ? `no account holds or held the address ${target.label}`
            : `no account with GitHub ID ${target.githubId}`,
        );
      }

      io.stdout(`target: ${describeAccount(account)}\n`);
      outcome = database.sqlite.transaction(() => {
        const result = act(database, account);

        if (result.ok && result.journal.length > 0) {
          try {
            const journal = createRevocationJournal(journalPath);

            for (const entry of result.journal) journal.append(entry);
          } catch (error) {
            throw new JournalWriteError(journalPath, error);
          }
        }

        return result;
      })();

      message =
        outcome.ok &&
        outcome.truncateLog === true &&
        !walTruncated(database.sqlite)
          ? `${outcome.message}; the write-ahead log is still in use, so its old pages go at the next nightly backup`
          : outcome.ok
            ? outcome.message
            : "";
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof JournalWriteError) {
      return fail(
        io,
        command,
        `${error.path} could not record the change, so nothing changed: ${error.message}`,
      );
    }

    return fail(io, command, failureSummary(error));
  }

  if (!outcome.ok) return fail(io, command, outcome.problem);
  io.stdout(`${message}\n`);

  return 0;
}

function credentialEntries(
  userId: string,
  credentials: ReturnType<typeof liveCredentialsOf>,
  at: number,
): RevocationJournalInput[] {
  return [
    ...credentials.servers.map((revoked): RevocationJournalInput => ({
      kind: "server",
      id: revoked.id,
      userId,
      credentialHash: revoked.credentialHash,
      at,
    })),
    ...credentials.machines.map((id): RevocationJournalInput => ({
      kind: "machine",
      id,
      userId,
      at,
    })),
  ];
}

function suspend(args: readonly string[], io: RelayCommandIo): number {
  const parsed = parseAccountCommandArgs(args, { reason: true, yes: false });

  if (parsed === null)
    return usage(io, targetUsage(SUSPEND_COMMAND, " [--reason TEXT]"));

  return withAccount(io, SUSPEND_COMMAND, parsed.target, ({ db }, account) => {
    const now = Date.now();

    const result = suspendAccount(db, {
      userId: account.userId,
      githubId: account.githubId,
      reason: parsed.reason,
      now,
    });

    return {
      ok: true,
      message: `suspended: ${result.servers} servers and ${result.machines} devices revoked, ${result.sessions} sessions ended, ${result.codes} pairing codes cancelled`,
      journal: [
        {
          kind: "user-block",
          githubId: result.githubId,
          userId: account.userId,
          reason: parsed.reason,
          at: now,
        },
        ...(account.userId === null
          ? []
          : credentialEntries(account.userId, result.revoked, now)),
      ],
    };
  });
}

function unsuspend(args: readonly string[], io: RelayCommandIo): number {
  const parsed = parseAccountCommandArgs(args, { reason: false, yes: false });

  if (parsed === null) return usage(io, targetUsage(UNSUSPEND_COMMAND, ""));

  return withAccount(
    io,
    UNSUSPEND_COMMAND,
    parsed.target,
    ({ db }, account) => {
      const now = Date.now();

      const revoked = unsuspendAccount(db, {
        userId: account.userId,
        githubId: account.githubId,
        now,
      });

      if (revoked === null) {
        return { ok: false, problem: "that account is not suspended" };
      }

      const lateCredentials = revoked.servers.length + revoked.machines.length;

      return {
        ok: true,
        message: `unsuspended; their servers and devices must pair again${
          lateCredentials === 0
            ? ""
            : ` (revoked ${lateCredentials} credentials issued while the suspension took effect)`
        }`,
        journal: [
          {
            kind: "user-unblock",
            githubId: account.githubId,
            userId: account.userId,
            at: now,
          },
          ...(account.userId === null
            ? []
            : credentialEntries(account.userId, revoked, now)),
        ],
      };
    },
  );
}

function walTruncated(sqlite: RelayDatabase["sqlite"]): boolean {
  const result: unknown = sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const first: unknown = Array.isArray(result) ? result[0] : null;

  return (
    typeof first === "object" &&
    first !== null &&
    "busy" in first &&
    first.busy === 0
  );
}

function deleteUser(args: readonly string[], io: RelayCommandIo): number {
  const parsed = parseAccountCommandArgs(args, { reason: false, yes: true });

  if (parsed === null) {
    return usage(io, targetUsage(DELETE_USER_COMMAND, " [--yes]"));
  }

  return withAccount(
    io,
    DELETE_USER_COMMAND,
    parsed.target,
    ({ db }, account) => {
      if (!parsed.yes) {
        return {
          ok: false,
          problem:
            "nothing deleted; check the target line, then run again with --yes",
        };
      }

      const userId = account.userId;

      if (userId === null) {
        return { ok: false, problem: "that GitHub account has no relay user" };
      }

      const now = Date.now();
      const credentials = liveCredentialsOf(db, userId);

      if (!deleteRelayUser(db, { userId, now })) {
        return { ok: false, problem: "the relay user was not deleted" };
      }

      return {
        ok: true,
        message:
          "deleted the account and everything it owned; its addresses stay retired and any suspension stays in force",
        truncateLog: true,
        journal: [
          ...credentialEntries(userId, credentials, now),
          {
            kind: "user-delete",
            githubId: account.githubId,
            userId,
            at: now,
          },
        ],
      };
    },
  );
}

const VIOLATION_RULES: ReadonlySet<RelayLabelRule> = new Set([
  "reserved",
  "look-alike",
  "digits-only",
  "trailing-hyphen",
]);

interface ClaimRow {
  label: string;
  kind: string;
  handle: string | null;
  github_login: string | null;
  github_id: string | null;
}

export interface LabelViolation {
  label: string;
  kind: string;
  rule: RelayLabelRule;
  answers: boolean;
  handle: string | null;
  github_login: string | null;
  github_id: string | null;
}

export function findLabelViolations(
  sqlite: Database.Database,
): LabelViolation[] {
  const rows = sqlite
    .prepare(
      "SELECT c.label AS label, c.kind AS kind, p.handle AS handle, u.github_login AS github_login, (SELECT a.account_id FROM account a WHERE a.user_id = c.user_id AND a.provider_id = 'github' ORDER BY a.created_at LIMIT 1) AS github_id FROM label_claim c LEFT JOIN user u ON u.id = c.user_id LEFT JOIN profile p ON p.user_id = c.user_id ORDER BY c.label",
    )
    .all() as ClaimRow[];

  return rows.flatMap((row) => {
    const rule = brokenRelayLabelRule(row.label);

    return rule !== null && VIOLATION_RULES.has(rule)
      ? [
          {
            label: row.label,
            kind: row.kind,
            rule,
            answers: !isRelayReservedLabel(row.label),
            handle: row.handle,
            github_login: row.github_login,
            github_id: row.github_id,
          },
        ]
      : [];
  });
}

function labelViolations(args: readonly string[], io: RelayCommandIo): number {
  if (args.length > 0) {
    return usage(io, `${LABEL_VIOLATIONS_COMMAND} takes no arguments`);
  }

  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      LABEL_VIOLATIONS_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  let lines: string[];

  try {
    const sqlite = openReadonly(path);

    try {
      lines = findLabelViolations(sqlite).map((violation) =>
        JSON.stringify(violation),
      );
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return fail(io, LABEL_VIOLATIONS_COMMAND, failureSummary(error));
  }

  if (lines.length > 0) io.stdout(`${lines.join("\n")}\n`);

  return 0;
}

const RENAME_FOLLOW_UP: Readonly<Record<string, string>> = {
  handle: "The owner's Omnyo server must pair again to answer there.",
  server: "The owner's Omnyo server must pair again to answer there.",
  machine: "The device answers there after its Omnyo restarts.",
};

function renameLabel(args: readonly string[], io: RelayCommandIo): number {
  const [rawOld, rawNew, ...extra] = args;
  const oldLabel = rawOld?.trim().toLowerCase();
  const newLabel = rawNew?.trim().toLowerCase();

  if (
    oldLabel === undefined ||
    newLabel === undefined ||
    extra.length > 0 ||
    !ADDRESS_LABEL.test(oldLabel) ||
    !ADDRESS_LABEL.test(newLabel)
  ) {
    return usage(
      io,
      `${RENAME_LABEL_COMMAND} takes the old and the new address`,
    );
  }

  const problem = validateLabel(newLabel) ?? relayLabelProblem(newLabel);

  if (problem !== null) {
    return fail(io, RENAME_LABEL_COMMAND, `${newLabel} is ${problem}`);
  }

  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      RENAME_LABEL_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  let message: string;

  try {
    const database = openRelayDatabase(path, io.migrations);

    try {
      const claim = database.sqlite
        .prepare(
          "SELECT kind, owner_id, user_id FROM label_claim WHERE label = ?",
        )
        .get(oldLabel) as
        | { kind: string; owner_id: string; user_id: string }
        | undefined;

      if (claim === undefined) {
        return fail(io, RENAME_LABEL_COMMAND, `no account holds ${oldLabel}`);
      }

      const account = resolveOperatorTarget(database.db, {
        kind: "label",
        label: oldLabel,
      });

      if (account !== null) {
        io.stdout(`target: ${describeAccount(account)}\n`);
      }

      try {
        database.sqlite.transaction(() => {
          const heldForRename = database.sqlite
            .prepare(
              "INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (?, ?, (SELECT account_id FROM account WHERE user_id = ? AND provider_id = 'github' ORDER BY created_at LIMIT 1), ?, ?) ON CONFLICT (label) DO NOTHING",
            )
            .run(
              newLabel,
              claim.kind,
              claim.user_id,
              claim.user_id,
              Date.now(),
            ).changes;

          if (claim.kind === "handle") {
            database.sqlite
              .prepare(
                "UPDATE profile SET handle = ? WHERE user_id = ? AND handle = ?",
              )
              .run(newLabel, claim.user_id, oldLabel);
            database.sqlite
              .prepare(
                "UPDATE server SET subdomain = ?, name = CASE name WHEN ? THEN ? ELSE name END WHERE user_id = ? AND subdomain = ?",
              )
              .run(newLabel, oldLabel, newLabel, claim.user_id, oldLabel);
          } else if (claim.kind === "server") {
            database.sqlite
              .prepare(
                "UPDATE server SET subdomain = ?, name = CASE name WHEN ? THEN ? ELSE name END WHERE id = ?",
              )
              .run(newLabel, oldLabel, newLabel, claim.owner_id);
          } else {
            database.sqlite
              .prepare("UPDATE machine SET subdomain = ? WHERE id = ?")
              .run(newLabel, claim.owner_id);
          }

          if (heldForRename > 0) {
            database.sqlite
              .prepare(
                "DELETE FROM relay_retired_label WHERE label = ? AND user_id = ?",
              )
              .run(newLabel, claim.user_id);
          }
        })();
      } catch (error) {
        const refusal = labelWriteRefusal(error);

        if (refusal === "taken") {
          return fail(io, RENAME_LABEL_COMMAND, `${newLabel} is taken`);
        }

        if (refusal === "label-limit") {
          return fail(
            io,
            RENAME_LABEL_COMMAND,
            `that account already holds or released ${RELAY_LABEL_LIMIT_PER_ACCOUNT} addresses`,
          );
        }

        throw error;
      }

      message =
        `renamed ${oldLabel} to ${newLabel}; ${oldLabel} stays retired for this account. ${RENAME_FOLLOW_UP[claim.kind] ?? ""}`.trimEnd();
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(io, RENAME_LABEL_COMMAND, failureSummary(error));
  }

  io.stdout(`${message}\n`);

  return 0;
}

const BACKUP_LABEL_SOURCES: ReadonlyArray<{ table: string; query: string }> = [
  {
    table: "label_claim",
    query: "SELECT label, kind, user_id FROM label_claim",
  },
  {
    table: "profile",
    query:
      "SELECT handle AS label, 'handle' AS kind, user_id FROM profile WHERE handle IS NOT NULL",
  },
  {
    table: "server",
    query:
      "SELECT subdomain AS label, 'server' AS kind, user_id FROM server WHERE subdomain IS NOT NULL",
  },
  {
    table: "machine",
    query:
      "SELECT subdomain AS label, 'machine' AS kind, user_id FROM machine WHERE subdomain IS NOT NULL",
  },
];

interface BackupLabel {
  label: string;
  kind: string;
  user_id: string;
  github_id: string | null;
}

function labelsInBackup(backup: Database.Database): BackupLabel[] {
  const tables = new Set(
    (
      backup
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );

  const githubIds = new Map<string, string>();

  if (tables.has("account")) {
    for (const row of backup
      .prepare(
        "SELECT user_id, account_id FROM account WHERE provider_id = 'github' ORDER BY created_at DESC",
      )
      .all() as Array<{ user_id: string; account_id: string }>) {
      githubIds.set(row.user_id, row.account_id);
    }
  }

  const labels = new Map<string, BackupLabel>();

  for (const source of BACKUP_LABEL_SOURCES) {
    if (!tables.has(source.table)) continue;

    for (const row of backup.prepare(source.query).all() as Array<{
      label: string;
      kind: string;
      user_id: string;
    }>) {
      const label = row.label.trim().toLowerCase();

      if (label === "" || labels.has(label)) continue;
      labels.set(label, {
        label,
        kind: row.kind,
        user_id: row.user_id,
        github_id: githubIds.get(row.user_id) ?? null,
      });
    }
  }

  return [...labels.values()];
}

function retireLabelsFrom(args: readonly string[], io: RelayCommandIo): number {
  const [backupPath, ...extra] = args;

  if (
    backupPath === undefined ||
    backupPath.trim() === "" ||
    extra.length > 0
  ) {
    return usage(
      io,
      `${RETIRE_LABELS_FROM_COMMAND} takes the path of an older copy of the relay database`,
    );
  }

  const path = databasePathFrom(io);

  if (path === null) {
    return fail(
      io,
      RETIRE_LABELS_FROM_COMMAND,
      "DATABASE_PATH must name the relay database file",
    );
  }

  let retired = 0;
  let found = 0;
  const reassigned: BackupLabel[] = [];

  try {
    const backup = openReadonly(backupPath);
    let labels: BackupLabel[];

    try {
      labels = labelsInBackup(backup);
    } finally {
      backup.close();
    }

    found = labels.length;
    const database = openRelayDatabase(path, io.migrations);

    try {
      const retire = database.sqlite.prepare(
        "INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM label_claim WHERE label = ?) ON CONFLICT (label) DO NOTHING",
      );

      const holder = database.sqlite.prepare(
        "SELECT c.user_id, (SELECT a.account_id FROM account a WHERE a.user_id = c.user_id AND a.provider_id = 'github' ORDER BY a.created_at LIMIT 1) AS github_id FROM label_claim c WHERE c.label = ?",
      );

      const at = Date.now();

      database.sqlite.transaction(() => {
        for (const entry of labels) {
          const changes = retire.run(
            entry.label,
            entry.kind,
            entry.github_id,
            entry.user_id,
            at,
            entry.label,
          ).changes;

          retired += changes;

          if (changes === 0) {
            const current = holder.get(entry.label) as
              | { user_id: string; github_id: string | null }
              | undefined;

            if (
              current !== undefined &&
              current.user_id !== entry.user_id &&
              (entry.github_id === null ||
                current.github_id !== entry.github_id)
            ) {
              reassigned.push(entry);
            }
          }
        }
      })();
    } finally {
      database.close();
    }
  } catch (error) {
    return fail(io, RETIRE_LABELS_FROM_COMMAND, failureSummary(error));
  }

  io.stdout(
    `retired ${retired} of the ${found} addresses in that copy; the rest are still held or already retired\n`,
  );

  for (const entry of reassigned) {
    io.stdout(
      `held now by another account than in that copy: ${entry.label} (${entry.kind}, GitHub ID ${entry.github_id ?? "unknown"}); an old daemon of the previous holder still reaches the new holder\n`,
    );
  }

  return 0;
}

export async function runRelayCommand(
  argv: readonly string[],
  io: RelayCommandIo,
): Promise<number | null> {
  const [command, ...args] = argv;

  switch (command) {
    case undefined:
      return null;
    case "revoke-workflow-share":
      return revokeShare(args, io);
    case BACKUP_COMMAND:
      return backup(args, io);
    case VACUUM_COMMAND:
      return vacuum(args, io);
    case AUDIT_TAIL_COMMAND:
      return auditTail(args, io);
    case SUSPEND_COMMAND:
      return suspend(args, io);
    case UNSUSPEND_COMMAND:
      return unsuspend(args, io);
    case DELETE_USER_COMMAND:
      return deleteUser(args, io);
    case LABEL_VIOLATIONS_COMMAND:
      return labelViolations(args, io);
    case RENAME_LABEL_COMMAND:
      return renameLabel(args, io);
    case RETIRE_LABELS_FROM_COMMAND:
      return retireLabelsFrom(args, io);
    default:
      return usage(io, `unknown command: ${command}`);
  }
}
