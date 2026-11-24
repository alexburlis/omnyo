import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createConnection,
  getAppSettings,
  migrate,
  setPluginKvValue,
  type DbConnection,
} from "@omnyo/db";
import type { ServerImportFile } from "@omnyo/server-archive";
import {
  isSealed,
  openSecretVault,
  writeSecretFile,
} from "@omnyo/secret-storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGINS,
  builtinPluginSource,
} from "../../src/services/plugins/builtin-registry.js";
import { CONNECT_HOLD_SOURCES } from "../../src/services/server-move/connect-hold.js";
import { applyServerImportFixups } from "../../src/services/server-move/pending-boot.js";
import { testLogger } from "../helpers/test-app.js";

const RELAY_SERVER_URL = "https://relay.example.test/s/move-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "omnyo-connect-credential-"));
  tempDirs.push(dataDir);

  return dataDir;
}

function makeDb(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);

  return db;
}

function moveMarker(dataDir: string): ServerImportFile {
  return {
    version: 1,
    kind: "move",
    moveId: "move-1",
    activationToken: null,
    sourceDataDir: dataDir,
    sourceServerHostId: null,
    targetHostId: null,
    serverUrl: `${RELAY_SERVER_URL}/`,
    importedEntries: ["app.db"],
    createdAt: 1,
    fixupsAppliedAt: null,
  };
}

type CredentialSource =
  | { kind: "kv row"; pluginId: string }
  | { kind: "sealed secret" | "plaintext secret"; pluginId: string };

const CREDENTIAL = JSON.stringify({
  serverUrl: RELAY_SERVER_URL,
  token: "fixture",
});

function credentialSecretPath(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId, "secrets", "credential");
}

async function fixupWithCredentialIn(source: CredentialSource | null) {
  const dataDir = await makeDataDir();
  const db = makeDb();
  const vault = await openSecretVault(dataDir);

  if (source?.kind === "kv row") {
    setPluginKvValue(db, source.pluginId, "credential", CREDENTIAL);
  } else if (source?.kind === "sealed secret") {
    await writeSecretFile(
      vault,
      credentialSecretPath(dataDir, source.pluginId),
      CREDENTIAL,
    );
  } else if (source?.kind === "plaintext secret") {
    const path = credentialSecretPath(dataDir, source.pluginId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, CREDENTIAL, { mode: 0o600 });
  }

  const result = await applyServerImportFixups({
    dataDir,
    db,
    logger: testLogger,
    marker: moveMarker(dataDir),
    vault,
  });

  return {
    dataDir,
    machineServerUrl: getAppSettings(db).machineServerUrl,
    machineServerUrlSet: result.machineServerUrlSet,
  };
}

describe("Connect credential lookup during a server move", () => {
  it.each<CredentialSource>([
    { kind: "kv row", pluginId: "omnyo-account" },
    { kind: "kv row", pluginId: "bb-account" },
    { kind: "kv row", pluginId: "connect" },
    { kind: "sealed secret", pluginId: "omnyo-account" },
    { kind: "sealed secret", pluginId: "connect" },
    { kind: "plaintext secret", pluginId: "omnyo-account" },
    { kind: "plaintext secret", pluginId: "connect" },
  ])(
    "treats the move address as the Connect relay when a $kind of $pluginId holds its credential",
    async (source) => {
      expect(await fixupWithCredentialIn(source)).toMatchObject({
        machineServerUrl: null,
        machineServerUrlSet: false,
      });
    },
  );

  it("seals an imported plaintext Connect credential while reading it", async () => {
    const { dataDir } = await fixupWithCredentialIn({
      kind: "plaintext secret",
      pluginId: "connect",
    });

    const stored = await readFile(
      credentialSecretPath(dataDir, "connect"),
      "utf8",
    );

    expect(isSealed(stored)).toBe(true);
    expect(stored).not.toContain(CREDENTIAL);
  });

  it("sets the move address as the direct server address when no Connect credential matches it", async () => {
    expect(await fixupWithCredentialIn(null)).toMatchObject({
      machineServerUrl: RELAY_SERVER_URL,
      machineServerUrlSet: true,
    });
  });

  it("holds the installed Omnyo account plugin's source", () => {
    const account = BUILTIN_PLUGINS.find(
      (plugin) => plugin.pluginId === "omnyo-account",
    );

    expect(account).toBeDefined();
    expect(CONNECT_HOLD_SOURCES).toContain(
      builtinPluginSource(account?.name ?? ""),
    );
  });
});
