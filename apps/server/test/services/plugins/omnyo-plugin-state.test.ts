import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPlugin,
  getPluginKvValue,
  threadTabs,
  type DbConnection,
} from "@omnyo/db";
import {
  inspectOmnyoStateRoot,
  stageOmnyoStateRoot,
} from "@omnyo/server-archive";
import {
  createOmnyoRootFixture,
  omnyoRootFixtureOwners,
} from "@omnyo/server-archive/test/omnyo-root-fixture";
import {
  adoptOmnyoPluginStateV1,
  assertOmnyoPluginNamespacesAdopted,
  omnyoPluginStateReceiptKeyV1,
} from "../../../src/services/plugins/omnyo-plugin-state-v1.js";
import {
  createPluginStateSnapshotOnDisk,
  readPluginSnapshotRegistration,
  restorePluginHostStateSnapshot,
  restorePluginStateSnapshot,
} from "../../../src/services/plugins/plugin-state-snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function seed(db: DbConnection) {
  db.$client.exec(`
    INSERT INTO hosts (id,name,type,created_at,updated_at) VALUES ('stable-host','same host','persistent',17,18);
    INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','unchanged bb user work',17,18);
    INSERT INTO threads (id,project_id,provider_id,origin_plugin_id,latest_attention_at,created_at,updated_at) VALUES ('thread','project','stable-provider','bb--git',17,17,18);
    INSERT INTO environments (id,project_id,host_id,environment_provider_id,environment_provider_plugin_id,created_at,updated_at) VALUES ('environment','project','stable-host','stable-environment-provider','bb--git',17,18);
    INSERT INTO plugins (id,source,source_kind,source_builtin_name,root_dir,version,enabled,installed_at,updated_at) VALUES ('bb--git','builtin:git','builtin','git','/pending','1.0.0',1,17,18);
    INSERT INTO plugin_artifacts (id,plugin_id,source_kind,path,integrity,content_hash,validation_result,created_at,updated_at) VALUES ('stable-artifact','bb--git','builtin','/pending','unchanged-integrity','unchanged-content-hash','valid',17,18);
    UPDATE plugins SET active_artifact_id = 'stable-artifact';
    INSERT INTO plugin_kv VALUES ('bb--git','opaque','{"text":"bb--git user text","permission":"denied"}',17);
    INSERT INTO plugin_settings VALUES ('bb--git','permissions','{"allowed":false,"paths":["/unchanged/bb"]}',18);
    INSERT INTO plugin_schedules (plugin_id,name,cron,next_run_at,last_run_at,last_status,last_error,updated_at) VALUES ('bb--git','stable-schedule','0 * * * *',123,99,'error','unchanged bb failure',18);
    INSERT INTO thread_plugin_metadata (thread_id,plugin_id,metadata_json) VALUES ('thread','bb--git','{"unchanged":"bb--git"}'),('thread','bb-core-work','{"obligationRevision":7,"historyRewriteRevision":3}');
    INSERT INTO thread_attention_imports VALUES ('bb--git',17);
    INSERT INTO pending_interactions (id,thread_id,origin_kind,plugin_id,status,payload,created_at,updated_at) VALUES ('interaction','thread','plugin','bb--git','pending','{"denied":true}',17,18);
    INSERT INTO app_settings_values VALUES ('pluginProviders:bb--git','[{"id":"stable-provider"}]',17),('pluginHostGeneration:bb--git','unchanged-generation',18);
    INSERT INTO app_settings_values VALUES ('managedBranchPrefix','"bb/"',18);
    INSERT INTO app_settings_values VALUES ('aiServiceSelections','{"thread-title":{"mode":"service","pluginId":"bb-ai","serviceId":"stable-service"},"commit-message":{"mode":"off"},"voice":{"mode":"automatic"}}',18),('keybindingOverrides','[{"command":"plugin:bb--git/open","shortcut":null},{"command":"thread.archive","shortcut":null},{"command":"plugin:bb--core/custom","shortcut":null}]',18);
    INSERT INTO app_settings (id,keybinding_overrides,updated_at) VALUES ('current','[{"command":"plugin:bb--git/open","shortcut":null},{"command":"thread.archive","shortcut":null},{"command":"plugin:bb--core/custom","shortcut":null}]',18);
    INSERT INTO app_theme (id,theme_id,updated_at) VALUES ('current','plugin:bb--git:stable-theme',18);
    INSERT INTO ui_preferences (key,value_json,revision,updated_at) VALUES ('sidebar.pluginPanelOrder','["__bb__/automations","bb--git/panel","foreign-bb/panel"]',7,18);
    INSERT INTO ui_preference_defaults (key,value_json) VALUES ('sidebar.footerOrder','["plugin:bb--git/open","builtin:mobile"]');
    INSERT INTO thread_tabs (thread_id,tabs_json,revision,updated_at) VALUES ('thread','[{"id":"stable-tab","kind":"plugin-panel","pluginId":"bb--git","actionId":"stable-action","paramsJson":"bb--git user payload","title":"unchanged bb title"}]',7,18);
    INSERT INTO queued_thread_messages (id,thread_id,content,origin_plugin_id,model,reasoning_level,permission_mode,service_tier,waiting_on,wait_holder,sort_key,created_at,updated_at,claim_token,claimed_at) VALUES ('pending-send','thread','unchanged bb--git message','bb--git','stable-model','high','default','priority','{"kind":"plugin","pluginId":"bb--git","reason":"unchanged bb reason"}','plugin:bb--git','V',17,18,'stable-claim',19);
  `);
}

async function fixture() {
  const result = await createOmnyoRootFixture(seed);
  roots.push(result.root);
  const pluginDir = join(result.input.sourceDataDir, "plugins", "bb--git");
  await mkdir(join(pluginDir, "secrets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(pluginDir, "secrets", "token"),
    "opaque fixture secret",
    { mode: 0o600 },
  );
  const pluginDb = new Database(join(pluginDir, "data.db"));
  pluginDb.exec(
    "CREATE TABLE _bb_applied_sql (hash TEXT); INSERT INTO _bb_applied_sql VALUES ('unchanged-applied-hash'); CREATE TABLE user_work (id TEXT PRIMARY KEY,value TEXT); INSERT INTO user_work VALUES ('stable-id','unchanged bb work')",
  );
  pluginDb.close();
  const db = createConnection(join(result.input.sourceDataDir, "bb.db"));
  let snapshot;

  try {
    db.$client
      .prepare("UPDATE plugins SET root_dir = ? WHERE id = 'bb--git'")
      .run(pluginDir);
    db.$client
      .prepare(
        "UPDATE plugin_artifacts SET path = ? WHERE id = 'stable-artifact'",
      )
      .run(pluginDir);
    const registration = getInstalledPlugin(db, "bb--git");

    if (registration === undefined) throw new Error("Missing fixture owner");
    snapshot = await createPluginStateSnapshotOnDisk({
      db,
      dataDir: result.input.sourceDataDir,
      pluginId: "bb--git",
      fromArtifactId: "old-artifact",
      toArtifactId: "new-artifact",
      now: 20,
      retainedUntil: 200,
      previousRegistration: registration,
    });
  } finally {
    db.$client.close();
  }

  const immutable = {
    state: hash(await readFile(snapshot.statePath)),
    registration: hash(await readFile(snapshot.registrationPath ?? "")),
    database: hash(await readFile(join(pluginDir, "data.db"))),
  };

  result.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(result.input.sourceDataDir)
  ).digest;

  return { ...result, pluginDir, snapshot, immutable };
}

it("adopts the same populated plugin namespace and preserves immutable rollback inputs", async () => {
  const input = await fixture();
  const source = createConnection(join(input.input.sourceDataDir, "bb.db"));
  expect(() => assertOmnyoPluginNamespacesAdopted(source)).toThrow(/stopped/);
  source.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    async prepareDestination(stage) {
      await adoptOmnyoPluginStateV1(stage);
      await adoptOmnyoPluginStateV1(stage);
    },
  });
  const dataDir = input.input.destinationDataDir;
  const pluginDir = join(dataDir, "plugins", "omnyo--git");
  expect(hash(await readFile(join(pluginDir, "data.db")))).toBe(
    input.immutable.database,
  );
  expect(await readFile(join(pluginDir, "secrets", "token"), "utf8")).toBe(
    "opaque fixture secret",
  );
  expect((await stat(join(pluginDir, "secrets", "token"))).mode & 0o777).toBe(
    0o600,
  );
  expect(
    await stat(join(dataDir, "plugins", "bb--git")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  const db = createConnection(join(dataDir, "app.db"));

  try {
    expect(() => assertOmnyoPluginNamespacesAdopted(db)).not.toThrow();
    expect(
      db.$client
        .prepare(
          "SELECT value,updated_at FROM app_settings_values WHERE key = 'managedBranchPrefix'",
        )
        .get(),
    ).toEqual({ value: '"omnyo/"', updated_at: 18 });
    expect(db.$client.prepare("SELECT id FROM hosts").all()).toEqual([
      { id: "stable-host" },
    ]);
    expect(
      db.$client
        .prepare(
          "SELECT id,environment_provider_plugin_id,environment_provider_id FROM environments",
        )
        .get(),
    ).toEqual({
      id: "environment",
      environment_provider_plugin_id: "omnyo--git",
      environment_provider_id: "stable-environment-provider",
    });
    expect(
      db.$client.prepare("SELECT provider_id FROM threads").pluck().get(),
    ).toBe("stable-provider");
    expect(getInstalledPlugin(db, "bb--git")).toBeUndefined();
    expect(getInstalledPlugin(db, "omnyo--git")).toMatchObject({
      activeArtifactId: "stable-artifact",
      rootDir: pluginDir,
      enabled: true,
      installedAt: 17,
      updatedAt: 18,
    });
    expect(
      db.$client
        .prepare(
          "SELECT id,plugin_id,integrity,content_hash,created_at,updated_at FROM plugin_artifacts",
        )
        .get(),
    ).toEqual({
      id: "stable-artifact",
      plugin_id: "omnyo--git",
      integrity: "unchanged-integrity",
      content_hash: "unchanged-content-hash",
      created_at: 17,
      updated_at: 18,
    });
    expect(getPluginKvValue(db, "omnyo--git", "opaque")).toBe(
      '{"text":"bb--git user text","permission":"denied"}',
    );
    expect(
      db.$client
        .prepare(
          "SELECT id,claim_token,claimed_at,content,origin_plugin_id,wait_holder,waiting_on FROM queued_thread_messages",
        )
        .get(),
    ).toEqual({
      id: "pending-send",
      claim_token: "stable-claim",
      claimed_at: 19,
      content: "unchanged bb--git message",
      origin_plugin_id: "omnyo--git",
      wait_holder: "plugin:omnyo--git",
      waiting_on:
        '{"kind":"plugin","pluginId":"omnyo--git","reason":"unchanged bb reason"}',
    });
    expect(
      db.$client
        .prepare(
          "SELECT metadata_json FROM thread_plugin_metadata WHERE plugin_id = 'omnyo-core-work'",
        )
        .pluck()
        .get(),
    ).toBe('{"obligationRevision":7,"historyRewriteRevision":3}');
    expect(
      db.$client
        .prepare("SELECT plugin_id,updated_at,value FROM plugin_settings")
        .get(),
    ).toEqual({
      plugin_id: "omnyo--git",
      updated_at: 18,
      value: '{"allowed":false,"paths":["/unchanged/bb"]}',
    });
    expect(
      db.$client
        .prepare(
          "SELECT plugin_id,name,next_run_at,last_run_at,last_status FROM plugin_schedules",
        )
        .get(),
    ).toEqual({
      plugin_id: "omnyo--git",
      name: "stable-schedule",
      next_run_at: 123,
      last_run_at: 99,
      last_status: "error",
    });
    expect(
      db.$client
        .prepare("SELECT plugin_id,payload,id FROM pending_interactions")
        .get(),
    ).toEqual({
      plugin_id: "omnyo--git",
      payload: '{"denied":true}',
      id: "interaction",
    });
    expect(getPluginKvValue(db, "tasks", "migration-fixture")).toContain(
      "stable-id",
    );
    expect(
      db.$client
        .prepare(
          "SELECT value FROM app_settings_values WHERE key = 'aiServiceSelections'",
        )
        .pluck()
        .get(),
    ).toContain('"pluginId":"omnyo-ai","serviceId":"stable-service"');
    expect(
      db.$client
        .prepare(
          "SELECT value FROM app_settings_values WHERE key = 'keybindingOverrides'",
        )
        .pluck()
        .get(),
    ).toBe(
      '[{"command":"plugin:omnyo--git/open","shortcut":null},{"command":"thread.archive","shortcut":null},{"command":"plugin:bb--core/custom","shortcut":null}]',
    );
    expect(
      db.$client
        .prepare("SELECT keybinding_overrides FROM app_settings")
        .pluck()
        .get(),
    ).toBe(
      '[{"command":"plugin:omnyo--git/open","shortcut":null},{"command":"thread.archive","shortcut":null},{"command":"plugin:bb--core/custom","shortcut":null}]',
    );
    const tabRow = db.select().from(threadTabs).get();
    expect(tabRow).toMatchObject({ revision: 7, updatedAt: 18 });
    expect(JSON.parse(tabRow?.tabsJson ?? "null")).toEqual([
      {
        id: "stable-tab",
        actionId: "stable-action",
        kind: "plugin-panel",
        paramsJson: "bb--git user payload",
        pluginId: "omnyo--git",
        title: "unchanged bb title",
      },
    ]);
    expect(
      db.$client.prepare("SELECT theme_id,updated_at FROM app_theme").get(),
    ).toEqual({ theme_id: "plugin:omnyo--git:stable-theme", updated_at: 18 });
    expect(
      db.$client
        .prepare("SELECT value_json,revision,updated_at FROM ui_preferences")
        .get(),
    ).toEqual({
      value_json:
        '["__core__/automations","omnyo--git/panel","foreign-bb/panel"]',
      revision: 7,
      updated_at: 18,
    });
    expect(
      db.$client
        .prepare("SELECT value_json FROM ui_preference_defaults")
        .pluck()
        .get(),
    ).toBe('["plugin:omnyo--git/open","builtin:mobile"]');
    expect(db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const registration = await readPluginSnapshotRegistration({
      db,
      snapshotId: input.snapshot.id,
    });

    expect(registration).toMatchObject({
      id: "omnyo--git",
      rootDir: pluginDir,
      installedAt: 17,
    });
    await restorePluginHostStateSnapshot({ db, snapshotId: input.snapshot.id });
    expect(getPluginKvValue(db, "omnyo--git", "opaque")).toContain(
      "permission",
    );
    expect(getPluginKvValue(db, "bb--git", "opaque")).toBeUndefined();
    expect(
      db.$client
        .prepare("SELECT value FROM app_settings_values WHERE key = ?")
        .get(omnyoPluginStateReceiptKeyV1),
    ).toBeDefined();
  } finally {
    db.$client.close();
  }

  const snapshotDir = input.snapshot.snapshotPath.replace(
    input.input.sourceDataDir,
    dataDir,
  );

  expect(hash(await readFile(join(snapshotDir, "host-state.json")))).toBe(
    input.immutable.state,
  );
  expect(
    hash(await readFile(join(snapshotDir, "previous-registration.json"))),
  ).toBe(input.immutable.registration);
  expect(await readFile(join(dataDir, "user-file.txt"), "utf8")).toBe(
    "unchanged user work",
  );
});

it("rejects a forged staging path before opening the source database for writes", async () => {
  const input = await fixture();
  const path = join(input.input.sourceDataDir, "bb.db");
  const before = hash(await readFile(path));
  await expect(
    adoptOmnyoPluginStateV1({
      ...input.input,
      dataDir: input.input.sourceDataDir,
      databasePath: path,
      databaseState: "present",
    }),
  ).rejects.toThrow(/staged profile path/);
  expect(hash(await readFile(path))).toBe(before);
});

it("refuses foreign snapshot rows before modifying host state or restore status", async () => {
  const input = await fixture();
  await writeFile(
    input.snapshot.statePath,
    JSON.stringify({
      kv: [
        {
          pluginId: "foreign-owner",
          key: "opaque",
          value: "foreign",
          updatedAt: 17,
        },
      ],
      settings: [],
      schedules: [],
    }),
  );
  const db = createConnection(join(input.input.sourceDataDir, "bb.db"));

  try {
    await expect(
      restorePluginStateSnapshot({
        db,
        dataDir: input.input.sourceDataDir,
        snapshotId: input.snapshot.id,
        now: 100,
      }),
    ).rejects.toThrow(/identity/);
    expect(getPluginKvValue(db, "bb--git", "opaque")).toContain("denied");
    expect(
      db.$client
        .prepare("SELECT status FROM plugin_state_snapshots WHERE id = ?")
        .pluck()
        .get(input.snapshot.id),
    ).toBe("ready");
    expect(getPluginKvValue(db, "foreign-owner", "opaque")).toBeUndefined();
  } finally {
    db.$client.close();
  }
});

it("recovers an actual killed conversion producer after the SQLite receipt commits", async () => {
  const input = await fixture();

  const script = `
    const {stageOmnyoStateRoot}=await import('./packages/server-archive/src/omnyo-state-root.ts');
    const {createConnection}=await import('./packages/db/src/index.ts');
    const {adoptOmnyoPluginStateV1}=await import('./apps/server/src/services/plugins/omnyo-plugin-state-v1.ts');
    await stageOmnyoStateRoot(JSON.parse(process.argv[1]),{openDatabase:path=>createConnection(path).$client,prepareDestination:async stage=>{await adoptOmnyoPluginStateV1(stage);process.kill(process.pid,'SIGKILL');}});
  `;

  const run = promisify(execFile);
  await expect(
    run(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(input.input),
      ],
      { cwd: join(import.meta.dirname, "../../../../.."), timeout: 10000 },
    ),
  ).rejects.toMatchObject({ signal: "SIGKILL" });

  const journal = JSON.parse(
    await readFile(join(input.input.jobDir, "root-adoption.json"), "utf8"),
  );

  expect(journal.phase).toBe("copied");
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    prepareDestination: adoptOmnyoPluginStateV1,
  });
  const db = createConnection(join(input.input.destinationDataDir, "app.db"));
  expect(getInstalledPlugin(db, "omnyo--git")).toBeDefined();
  expect(
    db.$client
      .prepare("SELECT id,claim_token FROM queued_thread_messages")
      .all(),
  ).toEqual([{ id: "pending-send", claim_token: "stable-claim" }]);
  db.$client.close();
});

it("refuses an orphan populated target before moving the old namespace", async () => {
  const input = await fixture();
  const db = createConnection(join(input.input.sourceDataDir, "bb.db"));
  db.$client.exec(
    "INSERT INTO plugin_settings VALUES ('omnyo--git','foreign','keep',19)",
  );
  db.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await expect(
    stageOmnyoStateRoot(input.input, {
      ...omnyoRootFixtureOwners,
      prepareDestination: adoptOmnyoPluginStateV1,
    }),
  ).rejects.toThrow(/collision/);
  expect(
    await readFile(
      join(
        input.input.jobDir,
        "root-staging",
        "plugins",
        "bb--git",
        "secrets",
        "token",
      ),
      "utf8",
    ),
  ).toBe("opaque fixture secret");
});

it("preserves a custom managed branch prefix and every existing environment branch", async () => {
  const input = await fixture();
  const source = createConnection(join(input.input.sourceDataDir, "bb.db"));
  source.$client
    .prepare(
      "UPDATE app_settings_values SET value = ? WHERE key = 'managedBranchPrefix'",
    )
    .run(JSON.stringify("custom/"));
  source.$client.exec(
    "UPDATE environments SET branch_name = 'bb/existing-user-work'",
  );
  source.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    prepareDestination: adoptOmnyoPluginStateV1,
  });
  const db = createConnection(join(input.input.destinationDataDir, "app.db"));
  expect(
    db.$client
      .prepare(
        "SELECT value,updated_at FROM app_settings_values WHERE key = 'managedBranchPrefix'",
      )
      .get(),
  ).toEqual({ value: '"custom/"', updated_at: 18 });
  expect(
    db.$client.prepare("SELECT branch_name FROM environments").pluck().get(),
  ).toBe("bb/existing-user-work");
  db.$client.close();
});

it("refuses a populated target directory without changing either namespace", async () => {
  const input = await fixture();
  const target = join(input.input.sourceDataDir, "plugins", "omnyo--git");
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, "foreign-state"), "preserve target");
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await expect(
    stageOmnyoStateRoot(input.input, {
      ...omnyoRootFixtureOwners,
      prepareDestination: adoptOmnyoPluginStateV1,
    }),
  ).rejects.toThrow(/directory collision/);
  expect(
    await readFile(
      join(
        input.input.jobDir,
        "root-staging",
        "plugins",
        "omnyo--git",
        "foreign-state",
      ),
      "utf8",
    ),
  ).toBe("preserve target");
  expect(
    hash(
      await readFile(
        join(
          input.input.jobDir,
          "root-staging",
          "plugins",
          "bb--git",
          "data.db",
        ),
      ),
    ),
  ).toBe(input.immutable.database);
});

it("refuses a linked plugin parent before opening its state namespaces", async () => {
  const input = await fixture();
  await rename(
    join(input.input.sourceDataDir, "plugins"),
    join(input.input.sourceDataDir, "retained-plugins"),
  );
  await symlink("retained-plugins", join(input.input.sourceDataDir, "plugins"));
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await expect(
    stageOmnyoStateRoot(input.input, {
      ...omnyoRootFixtureOwners,
      prepareDestination: adoptOmnyoPluginStateV1,
    }),
  ).rejects.toThrow(/plugin parent/);
  expect(
    hash(
      await readFile(
        join(
          input.input.sourceDataDir,
          "retained-plugins",
          "bb--git",
          "data.db",
        ),
      ),
    ),
  ).toBe(input.immutable.database);
});

it("reconciles moved files after a real SQLite transaction abort without replaying pending sends", async () => {
  const input = await fixture();
  const db = createConnection(join(input.input.sourceDataDir, "bb.db"));
  db.$client.exec(
    "CREATE TRIGGER interrupt_plugin_adoption BEFORE UPDATE ON plugin_settings BEGIN SELECT RAISE(ABORT, 'injected interruption'); END",
  );
  db.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;

  const owners = {
    ...omnyoRootFixtureOwners,
    prepareDestination: adoptOmnyoPluginStateV1,
  };

  await expect(stageOmnyoStateRoot(input.input, owners)).rejects.toThrow(
    /injected interruption/,
  );

  const staged = createConnection(
    join(input.input.jobDir, "root-staging", "app.db"),
  );

  expect(getInstalledPlugin(staged, "bb--git")).toBeDefined();
  expect(getInstalledPlugin(staged, "omnyo--git")).toBeUndefined();
  staged.$client.exec("DROP TRIGGER interrupt_plugin_adoption");
  staged.$client.close();
  await stageOmnyoStateRoot(input.input, owners);

  const final = createConnection(
    join(input.input.destinationDataDir, "app.db"),
  );

  expect(getInstalledPlugin(final, "omnyo--git")).toBeDefined();
  expect(
    final.$client
      .prepare("SELECT id,claim_token FROM queued_thread_messages")
      .all(),
  ).toEqual([{ id: "pending-send", claim_token: "stable-claim" }]);
  final.$client.close();
});

it("adopts the guide CLI preference without changing a denied choice or opaque plugin settings", async () => {
  const input = await fixture();
  const source = createConnection(join(input.input.sourceDataDir, "bb.db"));
  source.$client.exec(`
    INSERT INTO plugin_settings VALUES ('bb-guide','bbCli','false',31);
    INSERT INTO plugin_settings VALUES ('bb-guide','unknown-setting','{"bbCli":"opaque user data"}',32);
    INSERT INTO plugin_settings VALUES ('foreign-guide','bbCli','false',33);
  `);

  const original = source.$client
    .prepare("SELECT * FROM plugin_settings ORDER BY plugin_id,key")
    .all();

  source.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    async prepareDestination(stage) {
      await adoptOmnyoPluginStateV1(stage);
      await adoptOmnyoPluginStateV1(stage);
    },
  });

  const result = createConnection(
    join(input.input.destinationDataDir, "app.db"),
  );

  try {
    expect(
      result.$client
        .prepare(
          "SELECT key,value,updated_at FROM plugin_settings WHERE plugin_id = 'omnyo-guide' ORDER BY key",
        )
        .all(),
    ).toEqual([
      { key: "omnyoCli", value: "false", updated_at: 31 },
      {
        key: "unknown-setting",
        value: '{"bbCli":"opaque user data"}',
        updated_at: 32,
      },
    ]);
    expect(
      result.$client
        .prepare(
          "SELECT * FROM plugin_settings WHERE plugin_id = 'foreign-guide'",
        )
        .get(),
    ).toEqual({
      plugin_id: "foreign-guide",
      key: "bbCli",
      value: "false",
      updated_at: 33,
    });
    expect(
      result.$client
        .prepare("SELECT id,claim_token FROM queued_thread_messages")
        .all(),
    ).toEqual([{ id: "pending-send", claim_token: "stable-claim" }]);
  } finally {
    result.$client.close();
  }

  const unchanged = createConnection(join(input.input.sourceDataDir, "bb.db"));

  try {
    expect(
      unchanged.$client
        .prepare("SELECT * FROM plugin_settings ORDER BY plugin_id,key")
        .all(),
    ).toEqual(original);
  } finally {
    unchanged.$client.close();
  }
});

it.each(["dual", "malformed"] as const)(
  "refuses a %s guide CLI preference before accepting its stopped migration",
  async (kind) => {
    const input = await fixture();
    const source = createConnection(join(input.input.sourceDataDir, "bb.db"));
    source.$client
      .prepare("INSERT INTO plugin_settings VALUES ('bb-guide','bbCli',?,31)")
      .run(kind === "malformed" ? '"false"' : "false");

    if (kind === "dual")
      source.$client.exec(
        "INSERT INTO plugin_settings VALUES ('bb-guide','omnyoCli','false',32)",
      );

    const original = source.$client
      .prepare("SELECT * FROM plugin_settings ORDER BY plugin_id,key")
      .all();

    source.$client.close();
    input.input.expectedSourceDigest = (
      await inspectOmnyoStateRoot(input.input.sourceDataDir)
    ).digest;
    await expect(
      stageOmnyoStateRoot(input.input, {
        ...omnyoRootFixtureOwners,
        prepareDestination: adoptOmnyoPluginStateV1,
      }),
    ).rejects.toThrow();

    const unchanged = createConnection(
      join(input.input.sourceDataDir, "bb.db"),
    );

    try {
      expect(
        unchanged.$client
          .prepare("SELECT * FROM plugin_settings ORDER BY plugin_id,key")
          .all(),
      ).toEqual(original);
      expect(
        unchanged.$client
          .prepare("SELECT 1 FROM app_settings_values WHERE key = ?")
          .get(omnyoPluginStateReceiptKeyV1),
      ).toBeUndefined();
    } finally {
      unchanged.$client.close();
    }
  },
);

it("adopts only the owned AI service selection while retaining disabled state and foreign service IDs", async () => {
  const input = await fixture();
  const source = createConnection(join(input.input.sourceDataDir, "bb.db"));
  source.$client
    .prepare(
      "UPDATE app_settings_values SET value = ? WHERE key = 'aiServiceSelections'",
    )
    .run(
      JSON.stringify({
        "thread-title": { mode: "service", pluginId: "bb-ai", serviceId: "bb" },
        "commit-message": {
          mode: "service",
          pluginId: "foreign-ai",
          serviceId: "bb",
        },
        voice: { mode: "off" },
      }),
    );
  source.$client.exec(
    "INSERT INTO plugin_kv VALUES ('bb-ai','enabled','false',41); INSERT INTO plugin_kv VALUES ('bb-ai','opaque','{\"text\":\"bb account user notes\"}',42)",
  );
  source.$client.close();
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    async prepareDestination(stage) {
      await adoptOmnyoPluginStateV1(stage);
      await adoptOmnyoPluginStateV1(stage);
    },
  });

  const result = createConnection(
    join(input.input.destinationDataDir, "app.db"),
  );

  try {
    const row = result.$client
      .prepare(
        "SELECT value,updated_at FROM app_settings_values WHERE key = 'aiServiceSelections'",
      )
      .get();

    expect(row).toEqual({
      value: JSON.stringify({
        "thread-title": {
          mode: "service",
          pluginId: "omnyo-ai",
          serviceId: "omnyo",
        },
        "commit-message": {
          mode: "service",
          pluginId: "foreign-ai",
          serviceId: "bb",
        },
        voice: { mode: "off" },
      }),
      updated_at: 18,
    });
    expect(getPluginKvValue(result, "omnyo-ai", "enabled")).toBe("false");
    expect(getPluginKvValue(result, "omnyo-ai", "opaque")).toBe(
      '{"text":"bb account user notes"}',
    );
    expect(
      result.$client
        .prepare("SELECT id,claim_token FROM queued_thread_messages")
        .all(),
    ).toEqual([{ id: "pending-send", claim_token: "stable-claim" }]);
  } finally {
    result.$client.close();
  }
});

async function seedLegacyBundledMarketplaceV1(
  input: Awaited<ReturnType<typeof fixture>>,
) {
  const directory = join(
    input.input.sourceDataDir,
    "app-versions",
    "0.46.241+private.1",
    "node_modules",
    "bb-app",
    "server",
    "dist",
    "builtin-plugins",
  );

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "../../../package.json"),
    JSON.stringify({ name: "bb-app", version: "0.46.241+private.1" }),
  );

  const document = {
    schemaVersion: 2,
    name: "bb-official",
    displayName: "BB Official",
    description: "Plugins that ship with bb.",
    plugins: [
      {
        id: "bb--git",
        displayName: "Git",
        description: "Git actions",
        icon: "GitBranch",
        author: { name: "Alex" },
        source: { bundled: { plugin: "git" } },
      },
    ],
  };

  const manifest = JSON.stringify(document);
  await writeFile(join(directory, "marketplace.json"), manifest);
  const db = createConnection(join(input.input.sourceDataDir, "bb.db"));

  try {
    db.$client
      .prepare(
        "INSERT INTO plugin_marketplaces(name,source_kind,manifest_url,manifest_json,created_at,updated_at) VALUES ('bb-official','path',?,?,41,42)",
      )
      .run(directory, manifest);
    db.$client
      .prepare(
        "INSERT INTO plugin_marketplace_icons(marketplace_name,entry_id,source_url,content_type,content_hash,bytes,updated_at) VALUES ('bb-official','bb--git','https://example.invalid/unchanged-bb.svg','image/svg+xml','stable-icon-hash',?,43)",
      )
      .run(Buffer.from([0, 255, 42]));
    db.$client.exec(
      `UPDATE plugins SET provenance = 'catalog',catalog_marketplace_name = 'bb-official',catalog_entry_id = 'bb--git'; INSERT INTO plugin_marketplaces(name,source_kind,manifest_url,manifest_json,created_at,updated_at) VALUES ('foreign-market','https','https://example.invalid/bb/catalog.json','{"name":"foreign-market","opaque":"bb-official"}',51,52)`,
    );
    const registration = getInstalledPlugin(db, "bb--git");

    if (registration === undefined)
      throw new Error("Missing marketplace snapshot owner");

    const snapshot = await createPluginStateSnapshotOnDisk({
      db,
      dataDir: input.input.sourceDataDir,
      pluginId: "bb--git",
      fromArtifactId: "old-catalog-artifact",
      toArtifactId: "new-catalog-artifact",
      now: 44,
      retainedUntil: 244,
      previousRegistration: registration,
    });

    return {
      directory,
      manifest,
      snapshot,
      registrationSha256: hash(await readFile(snapshot.registrationPath ?? "")),
    };
  } finally {
    db.$client.close();
  }
}

it("adopts the source-attested bundled marketplace and references without losing icon bytes or foreign catalogs", async () => {
  const input = await fixture();
  const old = await seedLegacyBundledMarketplaceV1(input);
  input.input.expectedSourceDigest = (
    await inspectOmnyoStateRoot(input.input.sourceDataDir)
  ).digest;
  await stageOmnyoStateRoot(input.input, {
    ...omnyoRootFixtureOwners,
    async prepareDestination(stage) {
      await adoptOmnyoPluginStateV1(stage);
      await adoptOmnyoPluginStateV1(stage);
    },
  });
  const db = createConnection(join(input.input.destinationDataDir, "app.db"));

  try {
    const row = db.$client
      .prepare(
        "SELECT name,manifest_json,created_at,updated_at FROM plugin_marketplaces WHERE name = 'omnyo-official'",
      )
      .get();

    expect(row).toEqual({
      name: "omnyo-official",
      manifest_json: JSON.stringify({
        ...JSON.parse(old.manifest),
        name: "omnyo-official",
        displayName: "Omnyo Official",
        description: "Plugins that ship with Omnyo.",
      }),
      created_at: 41,
      updated_at: 42,
    });
    expect(
      db.$client
        .prepare(
          "SELECT catalog_marketplace_name,catalog_entry_id FROM plugins WHERE id = 'omnyo--git'",
        )
        .get(),
    ).toEqual({
      catalog_marketplace_name: "omnyo-official",
      catalog_entry_id: "omnyo--git",
    });
    expect(
      db.$client
        .prepare(
          "SELECT marketplace_name,entry_id,source_url,content_hash,bytes,updated_at FROM plugin_marketplace_icons",
        )
        .all(),
    ).toEqual([
      {
        marketplace_name: "omnyo-official",
        entry_id: "omnyo--git",
        source_url: "https://example.invalid/unchanged-bb.svg",
        content_hash: "stable-icon-hash",
        bytes: Buffer.from([0, 255, 42]),
        updated_at: 43,
      },
    ]);
    expect(
      db.$client
        .prepare(
          "SELECT manifest_url,manifest_json,created_at,updated_at FROM plugin_marketplaces WHERE name = 'foreign-market'",
        )
        .get(),
    ).toEqual({
      manifest_url: "https://example.invalid/bb/catalog.json",
      manifest_json: '{"name":"foreign-market","opaque":"bb-official"}',
      created_at: 51,
      updated_at: 52,
    });
    expect(
      db.$client
        .prepare("SELECT id,claim_token FROM queued_thread_messages")
        .all(),
    ).toEqual([{ id: "pending-send", claim_token: "stable-claim" }]);
    expect(
      await readPluginSnapshotRegistration({ db, snapshotId: old.snapshot.id }),
    ).toMatchObject({
      id: "omnyo--git",
      provenance: "catalog",
      catalogMarketplaceName: "omnyo-official",
      catalogEntryId: "omnyo--git",
    });
    expect(hash(await readFile(old.snapshot.registrationPath ?? ""))).toBe(
      old.registrationSha256,
    );
  } finally {
    db.$client.close();
  }
});

it.each(["row", "icon", "source", "document", "entry"] as const)(
  "refuses legacy bundled marketplace %s ambiguity before plugin moves and preserves source state",
  async (kind) => {
    const input = await fixture();
    const old = await seedLegacyBundledMarketplaceV1(input);
    const db = createConnection(join(input.input.sourceDataDir, "bb.db"));

    try {
      if (kind === "row")
        db.$client.exec(
          "INSERT INTO plugin_marketplaces(name,source_kind,manifest_url,manifest_json,created_at,updated_at) SELECT 'omnyo-official',source_kind,manifest_url,manifest_json,created_at,updated_at FROM plugin_marketplaces WHERE name = 'bb-official'",
        );

      if (kind === "icon")
        db.$client.exec(
          "INSERT INTO plugin_marketplace_icons SELECT 'omnyo-official',entry_id,source_url,content_type,etag,content_hash,bytes,updated_at FROM plugin_marketplace_icons WHERE marketplace_name = 'bb-official'",
        );

      if (kind === "source")
        db.$client
          .prepare(
            "UPDATE plugin_marketplaces SET manifest_url = ? WHERE name = 'bb-official'",
          )
          .run(join(input.input.sourceDataDir, "unknown", "builtin-plugins"));

      if (kind === "entry")
        db.$client.exec(
          "INSERT INTO plugin_marketplace_icons SELECT marketplace_name,'omnyo--git',source_url,content_type,etag,content_hash,bytes,updated_at FROM plugin_marketplace_icons WHERE marketplace_name = 'bb-official'",
        );
    } finally {
      db.$client.close();
    }

    if (kind === "document")
      await writeFile(
        join(old.directory, "marketplace.json"),
        JSON.stringify({
          ...JSON.parse(old.manifest),
          description: "different owner bytes",
        }),
      );
    input.input.expectedSourceDigest = (
      await inspectOmnyoStateRoot(input.input.sourceDataDir)
    ).digest;
    await expect(
      stageOmnyoStateRoot(input.input, {
        ...omnyoRootFixtureOwners,
        async prepareDestination(stage) {
          await expect(adoptOmnyoPluginStateV1(stage)).rejects.toThrow(
            /marketplace/,
          );
          const staged = createConnection(stage.databasePath);

          try {
            expect(
              staged.$client.prepare("SELECT id FROM plugins").all(),
            ).toEqual([{ id: "bb--git" }]);
            expect(
              staged.$client
                .prepare("SELECT 1 FROM app_settings_values WHERE key = ?")
                .get(omnyoPluginStateReceiptKeyV1),
            ).toBeUndefined();
            await expect(
              stat(join(stage.dataDir, "plugins", "bb--git")),
            ).resolves.toBeDefined();
            await expect(
              stat(join(stage.dataDir, "plugins", "omnyo--git")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            staged.$client.close();
          }

          throw new Error("expected marketplace preflight refusal");
        },
      }),
    ).rejects.toThrow("expected marketplace preflight refusal");
    expect(
      (await inspectOmnyoStateRoot(input.input.sourceDataDir)).digest,
    ).toBe(input.input.expectedSourceDigest);
  },
);
