import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { account, machine, profile, server, user } from "@omnyo/connect-db";
import { type Deps, createServer } from "./account/api.js";
import {
  LABEL_VIOLATIONS_COMMAND,
  RENAME_LABEL_COMMAND,
  RETIRE_LABELS_FROM_COMMAND,
  type RelayCommandIo,
  runRelayCommand,
} from "./cli.js";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import { assignMachineLabel } from "./gate/machine-label.js";
import { resolveLabel } from "./gate/resolve.js";
import { sourceMigrationDirectories } from "./migrations.js";
import { RELAY_LABEL_LIMIT_PER_ACCOUNT } from "./reserved-labels.js";

let root: string;

let databasePath: string;

function open(): RelayDatabase {
  return openRelayDatabase(databasePath, sourceMigrationDirectories());
}

function inspect<T>(read: (database: RelayDatabase) => T): T {
  const database = open();

  try {
    return read(database);
  } finally {
    database.close();
  }
}

async function inspectAsync<T>(
  read: (database: RelayDatabase) => Promise<T>,
): Promise<T> {
  const database = open();

  try {
    return await read(database);
  } finally {
    database.close();
  }
}

function deps(database: RelayDatabase): Deps {
  return {
    db: database.db,
    appUrl: "https://relay.example",
    serverUrlTemplate: "https://{label}.relay.example",
    closeTunnel: async () => {},
    recordRevocation: () => {},
    tunnelConnected: null,
  };
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

function seedLegacyAccount(
  id: string,
  githubId: string,
  handle: string,
  extra: { servers?: string[]; machines?: string[] } = {},
): void {
  inspect(({ db }) => {
    const now = new Date();

    db.insert(user)
      .values({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
        githubLogin: `${id}-login`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(account)
      .values({
        id: `account-${id}`,
        accountId: githubId,
        providerId: "github",
        userId: id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(profile).values({ userId: id, handle, createdAt: now }).run();
    db.insert(server)
      .values({
        id: `server-${id}`,
        userId: id,
        name: "default",
        subdomain: handle,
        credentialHash: `hash-${id}`,
        createdAt: now,
      })
      .run();

    for (const label of extra.servers ?? []) {
      db.insert(server)
        .values({
          id: `server-${label}`,
          userId: id,
          name: label,
          subdomain: label,
          createdAt: now,
        })
        .run();
    }

    for (const label of extra.machines ?? []) {
      db.insert(machine)
        .values({
          id: `machine-${label}`,
          userId: id,
          subdomain: label,
          credentialHash: `hash-${label}`,
          createdAt: now,
        })
        .run();
    }
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-cli-labels-"));
  databasePath = join(root, "relay.sqlite");
  open().close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("label-violations", () => {
  it("lists every existing address that breaks the current rules, with its owner", async () => {
    seedLegacyAccount("numeric", "1001", "31415926", {
      servers: ["alice-"],
    });
    seedLegacyAccount("greeter", "1002", "hello", {
      machines: ["githab-login"],
    });
    seedLegacyAccount("fine", "1003", "sawyer");

    const result = await run([LABEL_VIOLATIONS_COMMAND]);

    expect(result.code).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      {
        label: "31415926",
        kind: "handle",
        rule: "digits-only",
        answers: true,
        handle: "31415926",
        github_login: "numeric-login",
        github_id: "1001",
      },
      {
        label: "alice-",
        kind: "server",
        rule: "trailing-hyphen",
        answers: true,
        handle: "31415926",
        github_login: "numeric-login",
        github_id: "1001",
      },
      {
        label: "githab-login",
        kind: "machine",
        rule: "look-alike",
        answers: true,
        handle: "hello",
        github_login: "greeter-login",
        github_id: "1002",
      },
      {
        label: "hello",
        kind: "handle",
        rule: "reserved",
        answers: false,
        handle: "hello",
        github_login: "greeter-login",
        github_id: "1002",
      },
    ]);
  });
});

describe("retire-labels-from", () => {
  it("retires the addresses an older copy held that the database released before retirement existed", async () => {
    seedLegacyAccount("leaver", "1004", "leaver-box", {
      servers: ["leaver-spare"],
      machines: ["leaver-laptop"],
    });
    seedLegacyAccount("stranger", "1009", "stranger-box");
    const older = join(root, "older.sqlite");

    inspect(({ db, sqlite }) => {
      sqlite.exec(`VACUUM INTO '${older}'`);
      db.delete(server).where(eq(server.id, "server-leaver-spare")).run();
      db.delete(machine).where(eq(machine.id, "machine-leaver-laptop")).run();
      sqlite.exec("DELETE FROM relay_retired_label");
    });

    const result = await run([RETIRE_LABELS_FROM_COMMAND, older]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("retired 2 of the");

    await inspectAsync(async (database) => {
      expect(
        database.sqlite
          .prepare(
            "SELECT label, github_id FROM relay_retired_label ORDER BY label",
          )
          .all(),
      ).toEqual([
        { label: "leaver-laptop", github_id: "1004" },
        { label: "leaver-spare", github_id: "1004" },
      ]);
      expect(
        await createServer(deps(database), "stranger", "leaver-spare"),
      ).toEqual({ error: "taken" });
      expect(
        await createServer(deps(database), "leaver", "leaver-spare"),
      ).toMatchObject({ ok: true });
    });

    expect((await run([RETIRE_LABELS_FROM_COMMAND, older])).stdout).toContain(
      "retired 0 of the",
    );
  });

  it("names an address that a different account holds now, and not one its own account still holds", async () => {
    seedLegacyAccount("leaver", "1004", "leaver-box", {
      servers: ["leaver-spare"],
    });
    seedLegacyAccount("stranger", "1009", "stranger-box");
    const older = join(root, "older.sqlite");

    inspect(({ db, sqlite }) => {
      sqlite.exec(`VACUUM INTO '${older}'`);
      db.delete(server).where(eq(server.id, "server-leaver-spare")).run();
      sqlite.exec("DELETE FROM relay_retired_label");
    });

    await inspectAsync(async (database) => {
      expect(
        await createServer(deps(database), "stranger", "leaver-spare"),
      ).toMatchObject({ ok: true });
    });

    const result = await run([RETIRE_LABELS_FROM_COMMAND, older]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("retired 0 of the");
    expect(result.stdout).toContain(
      "held now by another account than in that copy: leaver-spare (server, GitHub ID 1004)",
    );
    expect(result.stdout).not.toContain("leaver-box (");
    expect(result.stdout).not.toContain("stranger-box (");
  });

  it("names no server or device address that its own account still holds", async () => {
    seedLegacyAccount("keeper", "1100", "keeper-box", {
      servers: ["keeper-work"],
      machines: ["keeper-phone"],
    });
    const older = join(root, "older.sqlite");

    inspect(({ sqlite }) => {
      sqlite.exec(`VACUUM INTO '${older}'`);
    });

    const result = await run([RETIRE_LABELS_FROM_COMMAND, older]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("retired 0 of the");
    expect(result.stdout).not.toContain("held now by another account");
  });

  it("refuses a missing copy without changing anything", async () => {
    const result = await run([
      RETIRE_LABELS_FROM_COMMAND,
      join(root, "missing.sqlite"),
    ]);

    expect(result.code).toBe(1);
    inspect(({ sqlite }) => {
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM relay_retired_label").get(),
      ).toEqual({ n: 0 });
    });
  });
});

describe("rename-label", () => {
  it("moves a handle that became reserved to a new address and keeps the old one retired", async () => {
    seedLegacyAccount("greeter", "1002", "hello");
    seedLegacyAccount("other", "1003", "sawyer");

    const result = await run([RENAME_LABEL_COMMAND, "hello", "hello-greeter"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("GitHub ID 1002");
    expect(result.stdout).toContain("renamed hello to hello-greeter");

    await inspectAsync(async (database) => {
      const { db } = database;

      expect(resolveLabel(db, "hello-greeter")).toMatchObject({
        kind: "server",
        userId: "greeter",
      });
      expect(resolveLabel(db, "hello")).toBeNull();
      expect(db.select({ handle: profile.handle }).from(profile).all()).toEqual(
        expect.arrayContaining([{ handle: "hello-greeter" }]),
      );
      expect(
        database.sqlite
          .prepare(
            "SELECT label, github_id FROM relay_retired_label WHERE label = 'hello'",
          )
          .all(),
      ).toEqual([{ label: "hello", github_id: "1002" }]);
      expect(await createServer(deps(database), "other", "hello")).toEqual({
        error: "reserved",
      });
    });
  });

  it("moves a server or device address and refuses one that another account retired", async () => {
    seedLegacyAccount("numeric", "1001", "numeric-owner", {
      servers: ["31415926"],
      machines: ["27182818"],
    });
    seedLegacyAccount("leaver", "1004", "leaver-box");
    await inspectAsync(async (database) => {
      const created = await createServer(
        deps(database),
        "leaver",
        "leaver-spare",
      );

      if (!("ok" in created)) throw new Error("setup: create failed");
      database.db.delete(server).where(eq(server.id, created.server.id)).run();
    });

    expect(
      (await run([RENAME_LABEL_COMMAND, "31415926", "leaver-spare"])).stderr,
    ).toContain("leaver-spare is taken");
    expect(
      (await run([RENAME_LABEL_COMMAND, "31415926", "numeric-api"])).code,
    ).toBe(0);
    expect(
      (await run([RENAME_LABEL_COMMAND, "27182818", "numeric-laptop"])).stdout,
    ).toContain("The device answers there after its Omnyo restarts.");

    inspect(({ db }) => {
      expect(resolveLabel(db, "numeric-api")).toMatchObject({
        kind: "server",
        userId: "numeric",
      });
      expect(resolveLabel(db, "numeric-laptop")).toMatchObject({
        kind: "machine",
        userId: "numeric",
      });
      expect(assignMachineLabel(db, "machine-27182818", "anything")).toBe(
        "numeric-laptop",
      );
    });
  });

  it("renames an address of an account that already reached its label limit", async () => {
    seedLegacyAccount("capped", "1005", "hello");
    inspect(({ sqlite }) => {
      const retire = sqlite.prepare(
        "INSERT INTO relay_retired_label (label, kind, github_id, user_id, retired_at) VALUES (?, 'server', '1005', 'capped', 0)",
      );

      for (let index = 0; index < RELAY_LABEL_LIMIT_PER_ACCOUNT; index += 1) {
        retire.run(`capped-old-${index}`);
      }
    });

    const result = await run([RENAME_LABEL_COMMAND, "hello", "hello-capped"]);

    expect(result.code).toBe(0);
    inspect(({ db, sqlite }) => {
      expect(resolveLabel(db, "hello-capped")).toMatchObject({
        kind: "server",
        userId: "capped",
      });
      expect(
        sqlite
          .prepare(
            "SELECT label FROM relay_retired_label WHERE label IN ('hello', 'hello-capped')",
          )
          .all(),
      ).toEqual([{ label: "hello" }]);
    });
  });

  it("refuses a new address that breaks the rules", async () => {
    seedLegacyAccount("greeter", "1002", "hello");

    for (const label of ["12345", "omny0-app", "sign-in", "bad-"]) {
      const result = await run([RENAME_LABEL_COMMAND, "hello", label]);

      expect(result.code, label).toBe(1);
    }
  });
});
