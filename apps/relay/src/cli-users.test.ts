import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sha256Hex,
  account,
  auditLog,
  connectCode,
  labelClaim,
  machine,
  profile,
  server,
  session,
  user,
} from "@omnyo/connect-db";
import {
  DELETE_USER_COMMAND,
  type RelayCommandIo,
  runRelayCommand,
  SUSPEND_COMMAND,
  UNSUSPEND_COMMAND,
} from "./cli.js";
import {
  findServerByCredential,
  redeemConnectCode,
  redeemMachineCode,
} from "./account/api.js";
import { SERVER_CREDENTIAL_PREFIX, generateToken } from "./account/tokens.js";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import { resolveBearerAccount } from "./gate/account-routes.js";
import {
  createRevocationJournal,
  replayRevocationJournal,
  revocationJournalPath,
} from "./gate/revocation.js";
import { resolveLabel } from "./gate/resolve.js";
import { sourceMigrationDirectories } from "./migrations.js";
import {
  DELETED_ACTION,
  isGitHubAccountBlocked,
  isUserBlocked,
  SUSPENDED_ACTION,
} from "./user-blocks.js";

const GITHUB_ID = "4242";

let root: string;

let databasePath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-cli-users-"));
  databasePath = join(root, "relay.sqlite");
  const database = open();

  try {
    const now = new Date();
    const { db } = database;

    db.insert(user)
      .values({
        id: "u1",
        name: "Mallory",
        email: "mallory@example.com",
        emailVerified: true,
        githubLogin: "mallory",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(account)
      .values({
        id: "a1",
        accountId: GITHUB_ID,
        providerId: "github",
        userId: "u1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(profile)
      .values({ userId: "u1", handle: "mallory", createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: "s1",
        userId: "u1",
        name: "mallory",
        subdomain: "mallory",
        credentialHash: "server-hash",
        createdAt: now,
      })
      .run();
    db.insert(machine)
      .values({
        id: "m1",
        userId: "u1",
        credentialHash: "machine-hash",
        createdAt: now,
      })
      .run();
    db.insert(session)
      .values({
        id: "sess1",
        userId: "u1",
        token: randomUUID(),
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } finally {
    database.close();
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function open(): RelayDatabase {
  return openRelayDatabase(databasePath, sourceMigrationDirectories());
}

async function run(
  argv: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";

  const io: RelayCommandIo = {
    env: { DATABASE_PATH: databasePath },
    stdin: (async function* empty() {})(),
    stdinIsTerminal: false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    migrations: sourceMigrationDirectories(),
  };

  const code = await runRelayCommand(argv, io);

  return { code, stdout, stderr };
}

function inspect<T>(read: (database: RelayDatabase) => T): T {
  const database = open();

  try {
    return read(database);
  } finally {
    database.close();
  }
}

describe("relay user commands", () => {
  it("suspends a user by handle: revokes servers and devices, ends sessions, hides addresses", async () => {
    const result = await run([SUSPEND_COMMAND, "mallory", "--reason", "spam"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("1 servers and 1 devices revoked");

    inspect(({ db }) => {
      expect(
        db.select().from(server).where(eq(server.id, "s1")).get(),
      ).toMatchObject({ credentialHash: null, revokedAt: expect.any(Date) });
      expect(
        db.select().from(machine).where(eq(machine.id, "m1")).get()?.revokedAt,
      ).toBeInstanceOf(Date);
      expect(db.select().from(session).all()).toHaveLength(0);
      expect(resolveLabel(db, "mallory")).toBeNull();
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(true);
      expect(
        db
          .select({ action: auditLog.action, detail: auditLog.detail })
          .from(auditLog)
          .all(),
      ).toEqual([
        {
          action: SUSPENDED_ACTION,
          detail: JSON.stringify({ githubId: GITHUB_ID, reason: "spam" }),
        },
      ]);
    });
  });

  it("keeps a very long suspension reason short enough for the journal to replay", async () => {
    const result = await run([
      SUSPEND_COMMAND,
      "mallory",
      "--reason",
      "x".repeat(300_000),
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "" });

    inspect(({ db }) => {
      const detail = db
        .select({ detail: auditLog.detail })
        .from(auditLog)
        .get()?.detail;

      expect(detail).toBeDefined();
      expect(detail?.length ?? 0).toBeLessThan(2_000);
    });

    expect(() =>
      inspect(({ db }) =>
        replayRevocationJournal(
          db,
          createRevocationJournal(revocationJournalPath(databasePath)),
        ),
      ),
    ).not.toThrow();
  });

  it("suspends by GitHub ID and lifts the suspension again", async () => {
    expect(
      await run([SUSPEND_COMMAND, "--github-id", GITHUB_ID]),
    ).toMatchObject({ code: 0 });
    expect(
      await run([UNSUSPEND_COMMAND, "--github-id", GITHUB_ID]),
    ).toMatchObject({ code: 0 });

    inspect(({ db }) => {
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(false);
    });

    expect(
      await run([UNSUSPEND_COMMAND, "--github-id", GITHUB_ID]),
    ).toMatchObject({ code: 1 });
  });

  it("deletes a user and everything they own only with --yes", async () => {
    expect(await run([DELETE_USER_COMMAND])).toMatchObject({ code: 64 });

    const preview = await run([DELETE_USER_COMMAND, "mallory"]);

    expect(preview.code).toBe(1);
    expect(preview.stdout).toMatch(/^target: handle mallory, /u);
    expect(preview.stderr).toContain("nothing deleted");
    inspect(({ db }) => {
      expect(db.select().from(user).all()).toHaveLength(1);
    });

    const result = await run([DELETE_USER_COMMAND, "mallory", "--yes"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });

    inspect(({ db }) => {
      expect(db.select().from(user).all()).toHaveLength(0);
      expect(db.select().from(account).all()).toHaveLength(0);
      expect(db.select().from(profile).all()).toHaveLength(0);
      expect(db.select().from(server).all()).toHaveLength(0);
      expect(db.select().from(machine).all()).toHaveLength(0);
      expect(db.select().from(session).all()).toHaveLength(0);
      expect(db.select().from(labelClaim).all()).toHaveLength(0);
      expect(
        db
          .select({ action: auditLog.action, userId: auditLog.userId })
          .from(auditLog)
          .all(),
      ).toEqual([{ action: DELETED_ACTION, userId: null }]);
    });
  });

  it("refuses an unknown target without changing anything", async () => {
    const result = await run([SUSPEND_COMMAND, "nobody"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "no account holds or held the address nobody",
    );
  });

  it.each([
    [[SUSPEND_COMMAND, "mallory", "--github-id", GITHUB_ID]],
    [[SUSPEND_COMMAND, "--github-id", "mallory"]],
    [[SUSPEND_COMMAND, "mallory.omnyo.link"]],
    [[SUSPEND_COMMAND]],
  ])("refuses an ambiguous or malformed target %j", async (argv) => {
    expect((await run(argv)).code).toBe(64);
  });
});

const VICTIM_GITHUB_ID = "58132134";

function seedAccount(input: {
  id: string;
  login: string;
  githubId: string;
  handle: string;
}): void {
  inspect(({ db }) => {
    const now = new Date();

    db.insert(user)
      .values({
        id: input.id,
        name: input.login,
        email: `${input.id}@example.com`,
        emailVerified: true,
        githubLogin: input.login,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(account)
      .values({
        id: `account-${input.id}`,
        accountId: input.githubId,
        providerId: "github",
        userId: input.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(profile)
      .values({ userId: input.id, handle: input.handle, createdAt: now })
      .run();
    db.insert(server)
      .values({
        id: `server-${input.id}`,
        userId: input.id,
        name: "default",
        subdomain: input.handle,
        credentialHash: `server-hash-${input.id}`,
        createdAt: now,
      })
      .run();
  });
}

describe("operator targets", () => {
  beforeEach(() => {
    seedAccount({
      id: "victim",
      login: "victim-login",
      githubId: VICTIM_GITHUB_ID,
      handle: "victim-box",
    });
    seedAccount({
      id: "attacker",
      login: "attacker-login",
      githubId: "99100001",
      handle: VICTIM_GITHUB_ID,
    });
  });

  it("acts on the holder of a digits-only address and names it before acting", async () => {
    const result = await run([SUSPEND_COMMAND, VICTIM_GITHUB_ID]);

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(
      `target: handle ${VICTIM_GITHUB_ID}, GitHub login attacker-login, GitHub ID 99100001 (matched by handle)`,
    );
    inspect(({ db }) => {
      expect(isUserBlocked(db, "attacker")).toBe(true);
      expect(isUserBlocked(db, "victim")).toBe(false);
      expect(resolveLabel(db, "victim-box")?.userId).toBe("victim");
    });
  });

  it("deletes the holder of a digits-only address, never the account with that GitHub ID", async () => {
    expect(
      (await run([DELETE_USER_COMMAND, VICTIM_GITHUB_ID, "--yes"])).code,
    ).toBe(0);

    inspect(({ db }) => {
      expect(db.select({ id: user.id }).from(user).all()).toEqual(
        expect.arrayContaining([{ id: "victim" }]),
      );
      expect(
        db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, "attacker"))
          .get(),
      ).toBeUndefined();
    });
  });

  it("reaches the account with a GitHub ID only through --github-id", async () => {
    const result = await run([
      SUSPEND_COMMAND,
      "--github-id",
      VICTIM_GITHUB_ID,
    ]);

    expect(result.stdout).toContain("GitHub login victim-login");
    inspect(({ db }) => {
      expect(isUserBlocked(db, "victim")).toBe(true);
      expect(isUserBlocked(db, "attacker")).toBe(false);
    });
  });

  it("suspends the owner of a secondary server address and of a device address", async () => {
    inspect(({ db }) => {
      const now = new Date();

      db.insert(server)
        .values({
          id: "s2",
          userId: "u1",
          name: "evil-box",
          subdomain: "evil-box",
          createdAt: now,
        })
        .run();
      db.insert(machine)
        .values({
          id: "m-victim",
          userId: "victim",
          subdomain: "victim-laptop",
          credentialHash: "machine-hash-victim",
          createdAt: now,
        })
        .run();
    });

    expect((await run([SUSPEND_COMMAND, "evil-box"])).stdout).toContain(
      "matched by server address",
    );
    expect((await run([SUSPEND_COMMAND, "victim-laptop"])).stdout).toContain(
      "matched by device address",
    );
    inspect(({ db }) => {
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(true);
      expect(isUserBlocked(db, "victim")).toBe(true);
      expect(isUserBlocked(db, "attacker")).toBe(false);
    });
  });

  it("blocks a GitHub account that has no relay user yet", async () => {
    const result = await run([SUSPEND_COMMAND, "--github-id", "7777777"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GitHub ID 7777777, no relay user");
    inspect(({ db }) => {
      expect(isGitHubAccountBlocked(db, "7777777")).toBe(true);
    });
  });
});

describe("suspension and deletion hold", () => {
  function snapshot(name: string): string {
    const copy = join(root, `${name}.sqlite`);

    inspect(({ sqlite }) => {
      sqlite.exec(`VACUUM INTO '${copy}'`);
    });

    return copy;
  }

  function restore(copy: string): void {
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    copyFileSync(copy, databasePath);
  }

  function replay() {
    return inspect(({ db }) =>
      replayRevocationJournal(
        db,
        createRevocationJournal(revocationJournalPath(databasePath)),
      ),
    );
  }

  it("cancels pairing codes and link approvals that were pending", async () => {
    inspect(({ db }) => {
      const now = new Date();
      const later = new Date(now.getTime() + 600_000);

      db.insert(connectCode)
        .values([
          {
            code: "PAIR-SERVER",
            userId: "u1",
            serverId: "s1",
            purpose: "server-pair",
            expiresAt: later,
            createdAt: now,
          },
          {
            code: "PAIR-DEVICE",
            userId: "u1",
            serverId: "s1",
            purpose: "machine-pair",
            expiresAt: later,
            createdAt: now,
          },
          {
            code: "LINK-APPROVED",
            userId: null,
            serverId: "s1",
            purpose: "server-link",
            approvedAt: now,
            expiresAt: later,
            createdAt: now,
          },
        ])
        .run();
    });

    expect((await run([SUSPEND_COMMAND, "mallory"])).stdout).toContain(
      "3 pairing codes cancelled",
    );
    inspect(({ db }) => {
      expect(db.select().from(connectCode).all()).toEqual([]);
    });
  });

  it("refuses codes and credentials written just after the suspension committed, and revokes them at unsuspend", async () => {
    expect((await run([SUSPEND_COMMAND, "mallory"])).code).toBe(0);
    const credential = generateToken(SERVER_CREDENTIAL_PREFIX);
    const credentialHash = await sha256Hex(credential);

    inspect(({ db }) => {
      const now = new Date();
      const later = new Date(now.getTime() + 600_000);

      db.insert(server)
        .values({
          id: "s-late",
          userId: "u1",
          name: "late",
          subdomain: "mallory-late",
          credentialHash,
          createdAt: now,
        })
        .run();
      db.insert(connectCode)
        .values([
          {
            code: "LATE-SERVER",
            userId: "u1",
            serverId: "s1",
            purpose: "server-pair",
            expiresAt: later,
            createdAt: now,
          },
          {
            code: "LATE-DEVICE",
            userId: "u1",
            serverId: "s1",
            purpose: "machine-pair",
            expiresAt: later,
            createdAt: now,
          },
        ])
        .run();
    });

    const database = open();

    try {
      const deps = {
        db: database.db,
        serverUrlTemplate: "https://{label}.relay.example",
      };

      expect(await redeemConnectCode(deps, "LATE-SERVER")).toEqual({
        error: "invalid-code",
        status: 404,
      });
      expect(await redeemMachineCode(deps, "LATE-DEVICE", null)).toEqual({
        error: "invalid-code",
        status: 404,
      });
      expect(
        await findServerByCredential(database.db, credential),
      ).toBeUndefined();
      expect(resolveBearerAccount(database.db, credential)).toBeNull();
    } finally {
      database.close();
    }

    const lifted = await run([UNSUSPEND_COMMAND, "mallory"]);

    expect(lifted.code).toBe(0);
    expect(lifted.stdout).toContain("revoked 1 credentials");
    inspect(({ db }) => {
      expect(
        db.select().from(server).where(eq(server.id, "s-late")).get()
          ?.revokedAt,
      ).not.toBeNull();
      expect(db.select().from(connectCode).all()).toEqual([]);
      expect(resolveBearerAccount(db, credential)).toBeNull();
    });
    expect(
      createRevocationJournal(revocationJournalPath(databasePath))
        .entries()
        .some((entry) => entry.kind === "server" && entry.id === "s-late"),
    ).toBe(true);
  });

  it("keeps a suspension, its revocations and its GitHub ID after a restore of an older backup", async () => {
    const before = snapshot("before-suspend");

    expect((await run([SUSPEND_COMMAND, "mallory"])).code).toBe(0);
    expect(
      createRevocationJournal(revocationJournalPath(databasePath))
        .entries()
        .map((entry) => entry.kind),
    ).toEqual(["user-block", "server", "machine"]);

    restore(before);
    expect(replay()).toMatchObject({ applied: 3, sessionsCleared: 1 });

    inspect(({ db }) => {
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(true);
      expect(
        db.select().from(server).where(eq(server.id, "s1")).get(),
      ).toMatchObject({ credentialHash: null, revokedAt: expect.any(Date) });
      expect(
        db.select().from(machine).where(eq(machine.id, "m1")).get()?.revokedAt,
      ).toBeInstanceOf(Date);
    });
    expect(replay()).toMatchObject({ applied: 0, sessionsCleared: 0 });
  });

  it("keeps refusing a GitHub account that signed up after the restored backup was taken", async () => {
    const before = snapshot("before-signup");
    seedAccount({
      id: "late",
      login: "late-login",
      githubId: "8080808",
      handle: "late-comer",
    });

    expect((await run([SUSPEND_COMMAND, "late-comer"])).code).toBe(0);
    restore(before);
    replay();

    inspect(({ db }) => {
      expect(db.select().from(user).where(eq(user.id, "late")).get()).toBe(
        undefined,
      );
      expect(isGitHubAccountBlocked(db, "8080808")).toBe(true);
    });
  });

  it("keeps the suspension through delete-user, retires the address, and keeps the user deleted after a restore", async () => {
    await run([SUSPEND_COMMAND, "mallory"]);
    const suspended = snapshot("suspended");

    const deletion = await run([DELETE_USER_COMMAND, "mallory", "--yes"]);

    expect(deletion.code).toBe(0);
    expect(deletion.stdout).toContain("any suspension stays in force");
    inspect(({ db, sqlite }) => {
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(true);
      expect(
        sqlite
          .prepare("SELECT label, github_id FROM relay_retired_label")
          .all(),
      ).toEqual([{ label: "mallory", github_id: GITHUB_ID }]);
      expect(
        db
          .select({ action: auditLog.action, detail: auditLog.detail })
          .from(auditLog)
          .where(eq(auditLog.action, DELETED_ACTION))
          .all(),
      ).toEqual([
        {
          action: DELETED_ACTION,
          detail: JSON.stringify({ githubId: GITHUB_ID }),
        },
      ]);
    });

    restore(suspended);
    replay();
    inspect(({ db }) => {
      expect(db.select().from(user).all()).toHaveLength(0);
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(true);
    });

    expect((await run([UNSUSPEND_COMMAND, "mallory"])).stdout).toContain(
      "matched by retired address",
    );
    restore(suspended);
    replay();
    inspect(({ db }) => {
      expect(isGitHubAccountBlocked(db, GITHUB_ID)).toBe(false);
    });
  });
});

it("revokes a workflow share through the operator journal", async () => {
  const id = "a".repeat(32);
  const db = open();
  db.db.run(
    sql`INSERT INTO relay_workflow_share VALUES (${id}, 'u1', ${Buffer.from("{}")}, '{}', 1, 9999999999999)`,
  );
  db.close();
  expect((await run(["revoke-workflow-share", id])).code).toBe(0);
  const reopened = open();
  expect(
    reopened.db.get(sql`SELECT 1 FROM relay_workflow_share WHERE id = ${id}`),
  ).toBeUndefined();
  reopened.close();
  expect(
    createRevocationJournal(revocationJournalPath(databasePath)).entries(),
  ).toContainEqual({
    kind: "workflow-share",
    v: 1,
    id,
    userId: "u1",
    at: expect.any(Number),
  });
});
