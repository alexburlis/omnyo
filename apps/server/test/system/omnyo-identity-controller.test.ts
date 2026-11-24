import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  chmod,
  cp,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  createConnection,
  getInstalledPlugin,
  getPluginArtifact,
  getPluginKvValue,
} from "@omnyo/db";
import {
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "@omnyo/plugin-build";
import {
  createRuntimeIdentity,
  writeMaintenanceHold,
  readMaintenanceHold,
  assertIdentityAdoptionHoldCanReleaseV1,
  OmnyoStateWorkPendingError,
  promoteDesktopUpdateHoldForIdentityV1,
} from "@omnyo/server-archive";
import type {
  IdentityAdoptionControlRequestV1,
  IdentityAdoptionPreflightRequestV1,
} from "@omnyo/domain";
import { admitConfiguredOmnyoStateWrites } from "@omnyo/config/omnyo-state-startup";
import { createOmnyoRootFixture } from "@omnyo/server-archive/test/omnyo-root-fixture";
import { inspectOmnyoStateTreeDigestV1 } from "../../../../packages/server-archive/omnyo-state-tree-v1.mjs";
import {
  stageIdentityAdoptionV1,
  rollBackIdentityAdoptionV1,
  preflightIdentityAdoptionV1,
  preflightIdentityAdoptionDatabaseV1,
  verifyIdentityAdoptionDatabaseV1,
} from "../../src/services/maintenance/omnyo-identity-controller-v1.js";
import { hashInstallDir } from "../../src/services/plugins/install-sources.js";
import { verifyBuiltinPluginArtifact } from "../../src/services/plugins/builtin-plugin-artifacts.js";
import * as identityArtifacts from "../../src/services/plugins/omnyo-plugin-artifacts-v1.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const f = await createOmnyoRootFixture((db) =>
    db.$client.exec(
      "INSERT INTO plugin_kv VALUES ('bb--git','denied-permission','false',17)",
    ),
  );

  roots.push(f.root);
  const runtimeRoot = join(f.root, "runtime");

  for (const path of ["dist", "server/dist", "host-daemon/dist", "app/dist"]) {
    await mkdir(join(runtimeRoot, path), { recursive: true });
    await writeFile(
      join(runtimeRoot, path, "entry.js"),
      "export const bound=true;\n",
    );
  }

  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: "0.46.244+private.1" }),
  );

  const identity = await createRuntimeIdentity(runtimeRoot, {
    runtimeVersion: "0.46.244+private.1",
    hostDaemonProtocolVersion: 253,
  });

  await writeFile(
    join(runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );
  await writeMaintenanceHold(f.input.sourceDataDir, {
    version: 1,
    id: f.input.migrationId,
    ownerId: f.input.ownerId,
    kind: "desktop-update",
    phase: "held",
    serverHostId: f.input.serverHostId,
    createdAt: 17,
    artifact: null,
  });

  const originalHold = await readFile(
    join(f.input.sourceDataDir, "server-maintenance-hold.json"),
  );

  const request = {
    version: 1,
    id: f.input.migrationId,
    ownerId: f.input.ownerId,
    serverHostId: f.input.serverHostId,
    expectedHoldSha256: createHash("sha256").update(originalHold).digest("hex"),
    binding: {
      version: 1,
      ownerKind: "coordinator",
      sourceDataDir: f.input.sourceDataDir,
      destinationDataDir: f.input.destinationDataDir,
      jobDir: f.input.jobDir,
      runtimeRoot,
      runtimeSha256: identity.runtimeSha256,
      archiveSha256: "a".repeat(64),
    },
  } satisfies IdentityAdoptionControlRequestV1;

  return { ...f, request, originalHold };
}

async function databaseCli(
  input:
    | {
        phase: "preflight-database";
        request: IdentityAdoptionPreflightRequestV1;
      }
    | { phase: "verify-database"; request: IdentityAdoptionControlRequestV1 },
) {
  const { phase, request } = input;
  await mkdir(request.binding.jobDir, { mode: 0o700, recursive: true });
  const path = join(request.binding.jobDir, phase + "-request.json");
  const raw = JSON.stringify(request);
  await writeFile(path, raw, { mode: 0o600, flag: "wx" });

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--conditions=source",
      "--import=tsx",
      fileURLToPath(
        new URL("../../src/omnyo-identity-adoption.ts", import.meta.url),
      ),
      "--phase",
      phase,
      "--request-file",
      path,
      "--request-sha256",
      hash(raw),
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      timeout: 8_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );

  const value: unknown = JSON.parse(stdout);

  return z
    .object({
      version: z.literal(2),
      verified: z.literal(true),
      capacityOnly: z.boolean(),
      migrationId: z.string(),
      artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      durationMs: z.number().nonnegative(),
      databaseBytes: z.number().int().positive(),
      proofSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .parse(value);
}

async function stageController(request: unknown) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await stageIdentityAdoptionV1(request);
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;

      if (error.progress.phase === "database-verification")
        await verifyIdentityAdoptionDatabaseV1(request);
    }
  }

  throw new Error(
    "Controller fixture exceeded its finite stage continuation bound",
  );
}

async function rollbackController(request: unknown) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await rollBackIdentityAdoptionV1(request);
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;
    }
  }

  throw new Error(
    "Controller fixture exceeded its finite rollback continuation bound",
  );
}

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

async function selectedArtifactFixture(
  kind: "path" | "builtin" | "git" = "path",
) {
  const f = await fixture();
  const artifactRoot = join(f.root, "built-git");
  await mkdir(artifactRoot);
  await writeFile(
    join(artifactRoot, "package.json"),
    JSON.stringify({
      name: "omnyo-plugin-omnyo--git",
      version: "1.0.1",
      type: "module",
      omnyo: {
        name: "Git",
        description: "Fixture Git",
        branding: { icon: "git-branch" },
        server: "server.ts",
      },
    }),
  );
  await writeFile(
    join(artifactRoot, "server.ts"),
    "export default function setup(){return {permission:'denied'}};\n",
  );
  await buildPluginServer(
    artifactRoot,
    "0.46.244+private.1",
    await resolvePluginBuildToolchain(join(f.root, "toolchain")),
  );

  if (kind === "builtin") {
    const packagePath = join(artifactRoot, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    await writeFile(
      packagePath,
      JSON.stringify({
        ...manifest,
        omnyo: { ...manifest.omnyo, server: "dist/server.js" },
      }),
    );

    const bundledRoot = join(
      f.request.binding.runtimeRoot,
      "server/dist/builtin-plugins/git",
    );

    await cp(artifactRoot, bundledRoot, { recursive: true });

    const identity = await createRuntimeIdentity(
      f.request.binding.runtimeRoot,
      {
        runtimeVersion: "0.46.244+private.1",
        hostDaemonProtocolVersion: 253,
      },
    );

    f.request.binding.runtimeSha256 = identity.runtimeSha256;
    await writeFile(
      join(f.request.binding.runtimeRoot, "dist/runtime-identity.json"),
      JSON.stringify(identity),
    );
  }

  const sourceRoot = "/Users/developer/projects/omnyo-plugins/git";
  const oldRoot = join(f.input.sourceDataDir, "plugins/cache/old-git");
  await mkdir(oldRoot, { recursive: true });
  await writeFile(
    join(oldRoot, "immutable.js"),
    "old ABI bytes stay immutable\n",
  );
  const source = createConnection(join(f.input.sourceDataDir, "bb.db"));

  try {
    source.$client
      .prepare(
        "INSERT INTO plugins (id,source,source_kind,source_path,root_dir,version,enabled,installed_at,updated_at) VALUES ('bb--git',?,'path',?,?,'1.0.0',0,17,18)",
      )
      .run(`path:${sourceRoot}`, sourceRoot, oldRoot);

    if (kind === "builtin")
      source.$client.exec(
        "UPDATE plugins SET source='builtin:git',source_kind='builtin',source_path=NULL,source_builtin_name='git'",
      );

    if (kind === "git")
      source.$client
        .prepare(
          "UPDATE plugins SET source=?,source_kind='git',source_path=NULL,source_git_url='https://github.com/example/omnyo-plugins.git',source_git_requested_ref=?,source_git_ref_kind='commit',git_resolved_commit=?",
        )
        .run(
          `git:https://github.com/example/omnyo-plugins.git@${"e".repeat(40)}`,
          "e".repeat(40),
          "e".repeat(40),
        );
    source.$client
      .prepare(
        "INSERT INTO plugin_artifacts (id,plugin_id,source_kind,path,integrity,content_hash,validation_result,created_at,updated_at) VALUES ('immutable-old','bb--git','builtin',?,'old-integrity','old-content-hash','valid',17,18)",
      )
      .run(oldRoot);
    source.$client.exec(
      "UPDATE plugins SET active_artifact_id='immutable-old'; INSERT INTO plugin_settings VALUES ('bb--git','permissions','{\"allowed\":false}',18)",
    );
  } finally {
    source.$client.close();
  }

  const inventoryPath = join(f.root, "inventory.json");

  const inventoryBytes = JSON.stringify({
    schema: 1,
    plugins: [{ id: "bb--git", version: "1.0.0", enabled: false }],
  });

  await writeFile(inventoryPath, inventoryBytes);

  const manifest = {
    schema: 1,
    coreSourceCommit: "c".repeat(40),
    pluginSourceCommit: "d".repeat(40),
    runtimeSha256: f.request.binding.runtimeSha256,
    installedInventorySha256: hash(inventoryBytes),
    entries: [
      {
        oldId: "bb--git",
        id: "omnyo--git",
        version: "1.0.1",
        sourceRoot,
        artifactRoot,
        contentDigest: await hashInstallDir(artifactRoot),
        artifacts: {
          server: {
            path: "dist/server.js",
            sha256: hash(await readFile(join(artifactRoot, "dist/server.js"))),
            metadataPath: "dist/server.meta.json",
            metadataSha256: hash(
              await readFile(join(artifactRoot, "dist/server.meta.json")),
            ),
            formatVersion: 2,
          },
        },
      },
    ],
  };

  const manifestPath = join(f.root, "artifact-selection.json");
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes);

  const request = {
    ...f.request,
    binding: {
      ...f.request.binding,
      pluginArtifactsManifestSha256: hash(bytes),
    },
    pluginArtifacts: {
      manifestPath,
      manifestSha256: hash(bytes),
      installedInventoryPath: inventoryPath,
    },
  };

  return { ...f, artifactRoot, oldRoot, sourceRoot, manifest, request };
}

it("reuses the builtin owner after a real SQLite interruption without adding artifacts or changing inventory proof", async () => {
  const f = await selectedArtifactFixture("builtin");
  const source = createConnection(join(f.input.sourceDataDir, "bb.db"));
  source.$client.exec(
    "CREATE TRIGGER injected_pointer_fault BEFORE UPDATE OF active_artifact_id ON plugins WHEN NEW.active_artifact_id != OLD.active_artifact_id BEGIN SELECT RAISE(ABORT,'injected artifact pointer failure'); END",
  );
  source.$client.close();
  await expect(stageController(f.request)).rejects.toThrow(
    /injected artifact pointer failure/,
  );
  const copied = createConnection(join(f.input.jobDir, "root-staging/app.db"));
  copied.$client.exec("DROP TRIGGER injected_pointer_fault");
  copied.$client.close();
  await stageController(f.request);
  await stageController(f.request);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));

  try {
    const row = getInstalledPlugin(db, "omnyo--git");

    if (row === undefined) throw new Error("Missing adopted builtin");
    const artifact = getPluginArtifact(db, row.activeArtifactId ?? "");
    expect(row.rootDir).toBe(
      join(
        f.input.destinationDataDir,
        "plugins/cache/builtin",
        row.activeArtifactId ?? "",
      ),
    );
    expect(artifact?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact?.contentHash).not.toBe(f.manifest.entries[0].contentDigest);
    expect(artifact?.contentHash).toBe(artifact?.integrity);
    expect(
      db.$client
        .prepare(
          "SELECT count(*) count FROM plugin_artifacts WHERE id LIKE 'identity_v1_%'",
        )
        .get(),
    ).toEqual({ count: 1 });
    await verifyBuiltinPluginArtifact({
      db,
      dataDir: f.input.destinationDataDir,
      row,
    });
    expect(getPluginArtifact(db, "immutable-old")?.contentHash).toBe(
      "old-content-hash",
    );
  } finally {
    db.$client.close();
  }
});

it("refuses builtin candidate bytes that differ from the verified selected runtime before changing its acquired hold", async () => {
  const f = await selectedArtifactFixture("builtin");

  const bundledEntry = join(
    f.request.binding.runtimeRoot,
    "server/dist/builtin-plugins/git/dist/server.js",
  );

  await writeFile(
    bundledEntry,
    (await readFile(bundledEntry, "utf8")) + "\nexport const altered=true;\n",
  );

  const identity = await createRuntimeIdentity(f.request.binding.runtimeRoot, {
    runtimeVersion: "0.46.244+private.1",
    hostDaemonProtocolVersion: 253,
  });

  await writeFile(
    join(f.request.binding.runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );
  f.manifest.runtimeSha256 = identity.runtimeSha256;
  const bytes = JSON.stringify(f.manifest);
  await writeFile(f.request.pluginArtifacts.manifestPath, bytes);

  const request = {
    ...f.request,
    binding: {
      ...f.request.binding,
      runtimeSha256: identity.runtimeSha256,
      pluginArtifactsManifestSha256: hash(bytes),
    },
    pluginArtifacts: {
      ...f.request.pluginArtifacts,
      manifestSha256: hash(bytes),
    },
  };

  await expect(stageController(request)).rejects.toThrow(
    "differs from its selected runtime bytes",
  );
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
});

it("retains git source intent and the selected commit without inventing a surviving checkout", async () => {
  const f = await selectedArtifactFixture("git");
  await stageController(f.request);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));

  try {
    const row = getInstalledPlugin(db, "omnyo--git");
    expect(row).toMatchObject({
      sourceKind: "git",
      sourceGitRequestedRef: "e".repeat(40),
      gitResolvedCommit: f.manifest.pluginSourceCommit,
    });
    expect(getPluginArtifact(db, row?.activeArtifactId ?? "")).toMatchObject({
      sourceKind: "git",
      gitResolvedCommit: f.manifest.pluginSourceCommit,
      gitCheckoutRoot: null,
    });
  } finally {
    db.$client.close();
  }
});

it("requires every installed plugin and adopts actual rebuilt bytes without changing disabled permissions or immutable history", async () => {
  const f = await selectedArtifactFixture();
  await expect(
    preflightIdentityAdoptionV1({ ...f.request, pluginArtifacts: undefined }),
  ).rejects.toThrow(/Every installed plugin/);
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  expect(
    (await preflightIdentityAdoptionV1(f.request)).installedPluginCount,
  ).toBe(1);
  await stageController(f.request);
  await stageController(f.request);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));

  try {
    const plugin = getInstalledPlugin(db, "omnyo--git");
    expect(plugin).toMatchObject({
      enabled: false,
      sourceKind: "path",
      sourcePath: f.sourceRoot,
      version: "1.0.1",
    });
    expect(plugin?.rootDir).toContain(
      join(f.input.destinationDataDir, "plugins/cache/identity-v1/omnyo--git"),
    );
    expect(plugin?.rootDir).not.toBe(f.artifactRoot);
    expect(await hashInstallDir(plugin?.rootDir ?? "")).toBe(
      f.manifest.entries[0].contentDigest,
    );
    expect(getPluginArtifact(db, plugin?.activeArtifactId ?? "")).toMatchObject(
      {
        sourceKind: "path",
        gitResolvedCommit: null,
        gitCheckoutRoot: null,
        bundledRootDir: null,
      },
    );
    expect(getPluginArtifact(db, "immutable-old")).toMatchObject({
      integrity: "old-integrity",
      contentHash: "old-content-hash",
      createdAt: 17,
      updatedAt: 18,
    });
    expect(getPluginKvValue(db, "omnyo--git", "denied-permission")).toBe(
      "false",
    );
    expect(
      db.$client
        .prepare(
          "SELECT value FROM plugin_settings WHERE plugin_id='omnyo--git'",
        )
        .get(),
    ).toEqual({ value: '{"allowed":false}' });
    expect(
      await readFile(
        join(f.input.destinationDataDir, "plugins/cache/old-git/immutable.js"),
        "utf8",
      ),
    ).toBe("old ABI bytes stay immutable\n");
  } finally {
    db.$client.close();
  }
});

it("refuses a sealed selection whose actual artifact SDK ABI is incompatible before fencing source state", async () => {
  const f = await selectedArtifactFixture();
  const metaPath = join(f.artifactRoot, "dist/server.meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  await writeFile(metaPath, JSON.stringify({ ...meta, runtimeAbi: 999 }));
  f.manifest.entries[0].artifacts.server.metadataSha256 = hash(
    await readFile(metaPath),
  );
  f.manifest.entries[0].contentDigest = await hashInstallDir(f.artifactRoot);
  const bytes = JSON.stringify(f.manifest);
  await writeFile(f.request.pluginArtifacts.manifestPath, bytes);

  const request = {
    ...f.request,
    binding: {
      ...f.request.binding,
      pluginArtifactsManifestSha256: hash(bytes),
    },
    pluginArtifacts: {
      ...f.request.pluginArtifacts,
      manifestSha256: hash(bytes),
    },
  };

  await expect(stageController(request)).rejects.toThrow(/runtime ABI/);
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
});

it("connects the real acquired hold, stopped root and populated namespace owners before first-write admission", async () => {
  const f = await fixture();
  const binding = await stageController(f.request);
  expect(await stageController(f.request)).toEqual(binding);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));
  expect(getPluginKvValue(db, "omnyo--git", "denied-permission")).toBe("false");
  expect(getPluginKvValue(db, "tasks", "migration-fixture")).toContain(
    "stable-id",
  );
  db.$client.close();
  const hold = readMaintenanceHold(f.input.destinationDataDir);

  if (hold === null) throw new Error("Missing actual staged hold");
  expect(() =>
    assertIdentityAdoptionHoldCanReleaseV1(f.input.destinationDataDir, hold),
  ).toThrow(/admitted destination/);
  await admitConfiguredOmnyoStateWrites(f.input.destinationDataDir);
  expect(() =>
    assertIdentityAdoptionHoldCanReleaseV1(f.input.destinationDataDir, hold),
  ).not.toThrow();
  await expect(rollbackController(f.request)).rejects.toThrow(
    /writers were admitted|state changed/,
  );
});

it("restores the exact original hold only after real pre-write rollback and replays safely", async () => {
  const f = await fixture();
  await stageController(f.request);
  await rollbackController(f.request);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  await expect(rollbackController(f.request)).resolves.toEqual({
    rolledBack: true,
    id: f.input.migrationId,
  });
  expect(readMaintenanceHold(f.input.sourceDataDir)?.kind).toBe(
    "desktop-update",
  );
});

it("serializes only known managed environment keys on the stopped clone and preserves source values and modes", async () => {
  const f = await fixture();
  const sourceConfig = join(f.input.sourceDataDir, "config.json");
  const sourceEnvironment = join(f.input.sourceDataDir, "env.json");

  const config = JSON.stringify({
    serverUrl: "http://127.0.0.1:38886",
    config: { BB_LOG_LEVEL: "debug" },
    customModels: [
      {
        providerId: "codex",
        model: "bb-user-model",
        displayName: "same user model",
      },
    ],
  });

  const environment = JSON.stringify({
    env: {
      BB_LOG_LEVEL: "info",
      CUSTOM_PLUGIN_VALUE: "unchanged bb user value",
      BB_CUSTOM_USER_VALUE: "opaque",
    },
  });

  await writeFile(sourceConfig, config, { mode: 0o600 });
  await writeFile(sourceEnvironment, environment, { mode: 0o600 });
  await stageController(f.request);
  expect(
    JSON.parse(
      await readFile(join(f.input.destinationDataDir, "config.json"), "utf8"),
    ),
  ).toMatchObject({
    config: { OMNYO_LOG_LEVEL: "debug" },
    customModels: [
      {
        providerId: "codex",
        model: "bb-user-model",
        displayName: "same user model",
      },
    ],
  });
  expect(
    JSON.parse(
      await readFile(join(f.input.destinationDataDir, "env.json"), "utf8"),
    ),
  ).toEqual({
    env: {
      OMNYO_LOG_LEVEL: "info",
      CUSTOM_PLUGIN_VALUE: "unchanged bb user value",
      BB_CUSTOM_USER_VALUE: "opaque",
    },
  });
  expect(
    (await stat(join(f.input.destinationDataDir, "env.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(await readFile(sourceEnvironment, "utf8")).toBe(environment);
  await rollbackController(f.request);
  expect(await readFile(sourceConfig, "utf8")).toBe(config);
});

it("refuses conflicting saved environment keys before changing the acquired hold or fencing source", async () => {
  const f = await fixture();
  await writeFile(
    join(f.input.sourceDataDir, "env.json"),
    JSON.stringify({ env: { BB_LOG_LEVEL: "info", OMNYO_LOG_LEVEL: "debug" } }),
  );
  await expect(stageController(f.request)).rejects.toThrow(
    /Saved managed state is invalid/,
  );
  expect(
    await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
  ).toBe(f.originalConfig);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
});

async function carriedDisabledUnmanagedFixture() {
  const f = await fixture();
  const sourceRoot = "/Users/developer/projects/omnyo-plugins/desktop-helper";
  const source = `path:${sourceRoot}`;
  const rawPermissions = '{"unknown":{"order":[3,1]},"allowed":false}';
  const rawData = '{"opaque":"desktop-helper","future":[2,1]}';

  const dataPath = join(
    f.input.sourceDataDir,
    "plugins/desktop-helper/user-data.json",
  );

  await mkdir(join(dataPath, ".."), { recursive: true });
  await writeFile(dataPath, rawData);
  const db = createConnection(join(f.input.sourceDataDir, "bb.db"));
  let beforeRow;
  let beforeArtifact;

  try {
    db.$client
      .prepare(
        "INSERT INTO plugins (id,source,source_kind,source_path,root_dir,version,enabled,installed_at,updated_at) VALUES ('desktop-helper',?,'path',?,?,'0.1.0',0,17,18)",
      )
      .run(source, sourceRoot, sourceRoot);
    db.$client
      .prepare(
        "INSERT INTO plugin_settings VALUES ('desktop-helper','permissions',?,18)",
      )
      .run(rawPermissions);
    db.$client
      .prepare(
        "INSERT INTO plugin_artifacts (id,plugin_id,source_kind,path,content_hash,validation_result,created_at,updated_at) VALUES ('retained-disabled-unmanaged','desktop-helper','path',?,'opaque-original-hash','pending',17,18)",
      )
      .run(sourceRoot);
    db.$client.exec(
      "UPDATE plugins SET active_artifact_id='retained-disabled-unmanaged' WHERE id='desktop-helper'",
    );
    beforeRow = getInstalledPlugin(db, "desktop-helper");
    beforeArtifact = getPluginArtifact(db, "retained-disabled-unmanaged");
  } finally {
    db.$client.close();
  }

  const installed = {
    id: "desktop-helper",
    version: "0.1.0",
    enabled: false,
    source,
    rootDir: sourceRoot,
    status: "disabled",
  };

  const entry = {
    oldId: "desktop-helper",
    id: "desktop-helper",
    version: "0.1.0",
    carriedDisabledUnmanagedV1: {
      enabled: false,
      sourceKind: "path",
      source,
      sourcePath: sourceRoot,
      rootDir: sourceRoot,
      status: "disabled",
    },
  };

  const inventoryPath = join(f.root, "carried-inventory.json");
  const inventoryBytes = JSON.stringify({ schema: 1, plugins: [installed] });
  await writeFile(inventoryPath, inventoryBytes);

  const manifest = {
    schema: 1,
    coreSourceCommit: "a".repeat(40),
    pluginSourceCommit: "b".repeat(40),
    runtimeSha256: f.request.binding.runtimeSha256,
    installedInventorySha256: hash(inventoryBytes),
    entries: [entry],
  };

  const manifestPath = join(f.root, "carried-manifest.json");
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes);

  const request = {
    ...f.request,
    binding: {
      ...f.request.binding,
      pluginArtifactsManifestSha256: hash(bytes),
    },
    pluginArtifacts: {
      manifestPath,
      manifestSha256: hash(bytes),
      installedInventoryPath: inventoryPath,
    },
  };

  return {
    ...f,
    request,
    beforeRow,
    beforeArtifact,
    rawData,
    rawPermissions,
    installed,
    entry,
  };
}

it("carries the exact disabled unmanaged row through real adoption without building or replacing its data", async () => {
  const f = await carriedDisabledUnmanagedFixture();
  expect(
    (await preflightIdentityAdoptionV1(f.request)).installedPluginCount,
  ).toBe(1);
  await stageController(f.request);
  await stageController(f.request);
  const db = createConnection(join(f.input.destinationDataDir, "app.db"));

  try {
    expect(getInstalledPlugin(db, "desktop-helper")).toEqual(f.beforeRow);
    expect(
      db.$client
        .prepare("SELECT count(*) AS count FROM plugin_artifacts")
        .get(),
    ).toEqual({ count: 1 });
    expect(getPluginArtifact(db, "retained-disabled-unmanaged")).toEqual(
      f.beforeArtifact,
    );
    expect(
      db.$client
        .prepare(
          "SELECT value FROM plugin_settings WHERE plugin_id='desktop-helper' AND key='permissions'",
        )
        .get(),
    ).toEqual({ value: f.rawPermissions });
    expect(
      await readFile(
        join(
          f.input.destinationDataDir,
          "plugins/desktop-helper/user-data.json",
        ),
        "utf8",
      ),
    ).toBe(f.rawData);
    expect(
      await readFile(
        join(f.input.sourceDataDir, "plugins/desktop-helper/user-data.json"),
        "utf8",
      ),
    ).toBe(f.rawData);
  } finally {
    db.$client.close();
  }
});

it("selects the finite disabled unmanaged carry only without a source owner and refuses changed or enabled rows", async () => {
  const f = await carriedDisabledUnmanagedFixture();
  const select = identityArtifacts.selectIdentityPluginCohortSourceV1;
  expect(select(f.installed, [])).toMatchObject({
    kind: "carried-disabled-unmanaged",
    entry: f.entry,
  });
  const owner = { id: "desktop-helper" };
  expect(select(f.installed, [owner])).toEqual({
    kind: "artifact",
    installed: f.installed,
    id: "desktop-helper",
    owner,
  });

  for (const change of [
    { enabled: true },
    { version: "0.1.1" },
    { id: "account-pool" },
    { source: "builtin:desktop-helper" },
    { rootDir: "/unknown/desktop-helper" },
    { status: "failed" },
  ])
    expect(() => select({ ...f.installed, ...change }, [])).toThrow(
      /no owned source/,
    );
});

it.each(["enabled", "version", "source", "rootDir", "managed"] as const)(
  "refuses a changed disabled unmanaged row before source fencing on %s",
  async (change) => {
    const f = await carriedDisabledUnmanagedFixture();
    const db = createConnection(join(f.input.sourceDataDir, "bb.db"));

    try {
      const updates = {
        enabled: "UPDATE plugins SET enabled=1 WHERE id='desktop-helper'",
        version: "UPDATE plugins SET version='0.1.1' WHERE id='desktop-helper'",
        source:
          "UPDATE plugins SET source='builtin:desktop-helper',source_kind='builtin' WHERE id='desktop-helper'",
        rootDir:
          "UPDATE plugins SET root_dir='/unknown/desktop-helper' WHERE id='desktop-helper'",
        managed:
          "UPDATE plugins SET provenance='catalog',catalog_entry_id='owned-catalog' WHERE id='desktop-helper'",
      };

      db.$client.exec(updates[change]);
    } finally {
      db.$client.close();
    }

    await expect(preflightIdentityAdoptionV1(f.request)).rejects.toThrow(
      /Carried disabled unmanaged/,
    );
    expect(
      await readFile(join(f.input.sourceDataDir, "config.json"), "utf8"),
    ).toBe(f.originalConfig);
    expect(
      await readFile(
        join(f.input.sourceDataDir, "server-maintenance-hold.json"),
      ),
    ).toEqual(f.originalHold);
  },
);

it("reuses bound native-kind capability preflight without restarting its census", async () => {
  const f = await fixture();

  const first = await preflightIdentityAdoptionV1({
    ...f.request,
    expectedHoldSha256: undefined,
  });

  expect(first.ready).toBe(true);
  const censusPath = join(f.input.jobDir, "source-kinds-preflight-v1.json");
  const before = await stat(censusPath, { bigint: true });
  const repeated = await preflightIdentityAdoptionV1(f.request);
  expect(repeated.sourceRootCapabilities).toEqual(first.sourceRootCapabilities);
  expect((await stat(censusPath, { bigint: true })).mtimeNs).toBe(
    before.mtimeNs,
  );
  const receiptPath = join(f.input.jobDir, "source-capabilities-v2.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  expect(receipt.version).toBe(2);
  expect(receipt.request).toMatchObject({
    id: f.request.id,
    ownerId: f.request.ownerId,
    serverHostId: f.request.serverHostId,
    binding: f.request.binding,
  });
  expect(receipt.request).not.toHaveProperty("expectedHoldSha256");
  expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  await expect(
    stat(join(f.input.jobDir, "root-adoption.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
});

it.each(["malformed", "request", "runtime", "root", "permissions", "hardlink"])(
  "refuses unbound source capability receipts before staging on %s",
  async (change) => {
    const f = await fixture();
    await preflightIdentityAdoptionV1(f.request);
    const receipt = join(f.input.jobDir, "source-capabilities-v2.json");
    let request = f.request;

    switch (change) {
      case "malformed":
        await writeFile(receipt, "{}");
        break;
      case "request":
        request = { ...request, ownerId: "another-owner" };
        break;
      case "runtime":
        request = {
          ...request,
          binding: { ...request.binding, runtimeSha256: "f".repeat(64) },
        };
        break;
      case "root":
        await rename(
          f.input.sourceDataDir,
          f.input.sourceDataDir + ".owned-original",
        );
        await mkdir(f.input.sourceDataDir, { mode: 0o700 });
        await writeFile(
          join(f.input.sourceDataDir, "host-id"),
          f.request.serverHostId,
        );
        break;
      case "permissions":
        await chmod(receipt, 0o644);
        break;
      case "hardlink":
        await link(receipt, receipt + ".owned-link");
        break;
    }

    await expect(preflightIdentityAdoptionV1(request)).rejects.toThrow();
    await expect(
      stat(join(f.input.jobDir, "root-adoption.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(f.input.jobDir, "write-admission.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const source =
      change === "root"
        ? f.input.sourceDataDir + ".owned-original"
        : f.input.sourceDataDir;

    expect(
      await readFile(join(source, "server-maintenance-hold.json")),
    ).toEqual(f.originalHold);
  },
);

it("keeps prepared controller phases outside admission and refuses stage after abort", async () => {
  const f = await fixture();
  await preflightIdentityAdoptionV1(f.request);
  let pending: unknown;

  try {
    await stageIdentityAdoptionV1(f.request);
  } catch (error) {
    pending = error;
  }

  expect(pending).toBeInstanceOf(OmnyoStateWorkPendingError);

  if (!(pending instanceof OmnyoStateWorkPendingError)) throw pending;
  expect(pending.progress.phase).toBe("clone");
  expect(readMaintenanceHold(f.input.sourceDataDir)?.kind).toBe("migration");
  const journal = join(f.input.jobDir, "root-adoption.json");
  expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({
    phase: "prepared",
    digestAlgorithm: "state-tree-v2",
  });
  await expect(
    stat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(join(f.input.jobDir, "root-staging")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const checkpoint = join(f.input.jobDir, "root-source-digest-v2.json");
  const before = await stat(checkpoint, { bigint: true });
  await rollbackController(f.request);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
  expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(
    before.mtimeNs,
  );
  expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({
    phase: "aborted-before-admission",
  });
  await expect(stageIdentityAdoptionV1(f.request)).rejects.toThrow(
    /selected rollback or abort/u,
  );
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
  expect(await rollbackController(f.request)).toEqual({
    rolledBack: true,
    id: f.request.id,
  });
});

it("preserves an exact original unstaged hold without writing a job", async () => {
  const f = await fixture();
  expect(await rollbackController(f.request)).toEqual({
    rolledBack: true,
    id: f.request.id,
  });
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
  await expect(stat(f.input.jobDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses an original unstaged hold that still has a source-fence owner", async () => {
  const f = await fixture();
  await mkdir(f.input.jobDir, { mode: 0o700 });
  const path = join(f.input.jobDir, "held-source-fence-v1.json");
  await writeFile(path, "{}", { mode: 0o600 });
  await expect(rollbackController(f.request)).rejects.toThrow(
    /staging or source-fence owner/u,
  );
  expect(await readFile(path, "utf8")).toBe("{}");
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
});

it("keeps stopped preflight from writing SQLite during a partial source fingerprint", async () => {
  const f = await fixture();
  await preflightIdentityAdoptionV1(f.request);
  await promoteDesktopUpdateHoldForIdentityV1(f.request);
  await preflightIdentityAdoptionV1(f.request);
  const proof = join(f.input.jobDir, "source-stopped-preflight-v2.json");
  expect((await stat(proof)).mode & 0o777).toBe(0o600);
  const shm = join(f.input.sourceDataDir, "bb.db-shm");
  await rm(shm, { force: true });

  const config = await stat(join(f.input.sourceDataDir, "config.json"), {
    bigint: true,
  });

  const options = {
    checkpointPath: join(f.input.jobDir, "root-source-digest-v2.json"),
    maxShards: 1,
    config: {
      kind: "normalized",
      sha256: hash(f.originalConfig),
      binding: {
        device: config.dev.toString(),
        inode: config.ino.toString(),
        uid: Number(config.uid),
        gid: Number(config.gid),
        mode: Number(config.mode & 0o7777n),
        size: Number(config.size),
        mtimeNs: config.mtimeNs.toString(),
        ctimeNs: config.ctimeNs.toString(),
        nlink: Number(config.nlink),
      },
    },
  } satisfies Parameters<typeof inspectOmnyoStateTreeDigestV1>[1];

  const partial = await inspectOmnyoStateTreeDigestV1(
    f.input.sourceDataDir,
    options,
  );

  expect(partial.complete).toBe(false);
  const before = await readFile(options.checkpointPath);
  await preflightIdentityAdoptionV1(f.request);
  await expect(stat(shm)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(options.checkpointPath)).toEqual(before);
  expect(
    (await inspectOmnyoStateTreeDigestV1(f.input.sourceDataDir, options))
      .complete,
  ).toBe(true);
  await expect(
    stat(join(f.input.jobDir, "root-adoption.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const completed = await readFile(options.checkpointPath);
  await rollbackController(f.request);
  expect(
    await readFile(join(f.input.sourceDataDir, "server-maintenance-hold.json")),
  ).toEqual(f.originalHold);
  expect(await readFile(options.checkpointPath)).toEqual(completed);
});

it.each(["missing hold", "released tombstone"] as const)(
  "verifies source database capacity with its readonly owner before acquiring a hold: %s",
  async (state) => {
    const f = await fixture();

    const holdPath = join(
      f.input.sourceDataDir,
      "server-maintenance-hold.json",
    );

    const configPath = join(f.input.sourceDataDir, "config.json");
    const originalConfig = await readFile(configPath);

    if (state === "missing hold") await rm(holdPath);
    else {
      const hold = readMaintenanceHold(f.input.sourceDataDir);

      if (hold === null) throw new Error("Missing fixture hold");
      await writeMaintenanceHold(f.input.sourceDataDir, {
        ...hold,
        id: "previous-identity-release",
        phase: "released",
      });
    }

    const before = state === "missing hold" ? null : await readFile(holdPath);

    const result = await databaseCli({
      phase: "preflight-database",
      request:
        state === "missing hold"
          ? { ...f.request, expectedHoldSha256: undefined }
          : f.request,
    });

    expect(result).toMatchObject({
      version: 2,
      verified: true,
      capacityOnly: true,
      migrationId: f.request.id,
      artifactDigest: f.request.binding.runtimeSha256,
    });
    expect(result.proofSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.databaseBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    if (before === null)
      await expect(stat(holdPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(holdPath)).toEqual(before);
    expect(await readFile(configPath)).toEqual(originalConfig);
    await expect(
      stat(join(f.input.jobDir, "root-adoption.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(f.input.jobDir, "write-admission.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.input.destinationDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each([
  "source-stopped-preflight-v2.json",
  "root-source-digest-v2.json",
  "held-source-fence-v1.json",
  "root-staging",
  "write-admission.json",
])(
  "refuses source database capacity before opening SQLite after %s",
  async (checkpoint) => {
    const f = await fixture();
    await mkdir(f.input.jobDir, { mode: 0o700 });
    await writeFile(join(f.input.jobDir, checkpoint), "{}", { mode: 0o600 });
    await rm(join(f.input.sourceDataDir, "bb.db"));
    await expect(
      preflightIdentityAdoptionDatabaseV1(f.request),
    ).rejects.toThrow(/source database capacity.*phase/u);
    expect(
      await readFile(
        join(f.input.sourceDataDir, "server-maintenance-hold.json"),
      ),
    ).toEqual(f.originalHold);
  },
);

it.each(["configuration-fence", "promoted-hold", "foreign-hold"])(
  "refuses source database capacity before SQLite for %s",
  async (state) => {
    const f = await fixture();

    if (state === "configuration-fence")
      await writeFile(
        join(f.input.sourceDataDir, "config.json"),
        JSON.stringify({
          ...JSON.parse(f.originalConfig),
          stateMigration: {
            journalPath: join(f.input.jobDir, "write-admission.json"),
            binding: {
              migrationId: f.request.id,
              sourceDataDir: f.input.sourceDataDir,
              destinationDataDir: f.input.destinationDataDir,
              sourceDigest: f.input.expectedSourceDigest,
              destinationDigest: "d".repeat(64),
              artifactDigest: f.request.binding.runtimeSha256,
            },
          },
        }),
      );
    else if (state === "promoted-hold")
      await promoteDesktopUpdateHoldForIdentityV1(f.request);
    else {
      const hold = readMaintenanceHold(f.input.sourceDataDir);

      if (hold === null) throw new Error("Missing fixture hold");
      await writeMaintenanceHold(f.input.sourceDataDir, {
        ...hold,
        ownerId: "another-owner",
      });
    }

    const before = await readFile(
      join(f.input.sourceDataDir, "server-maintenance-hold.json"),
    );

    await rm(join(f.input.sourceDataDir, "bb.db"));
    await expect(
      preflightIdentityAdoptionDatabaseV1(f.request),
    ).rejects.toThrow(/source database capacity.*phase/u);
    expect(
      await readFile(
        join(f.input.sourceDataDir, "server-maintenance-hold.json"),
      ),
    ).toEqual(before);
  },
);

it("verifies the converted database through its owner before sealing or admission", async () => {
  const f = await fixture();
  let pending = false;

  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await stageIdentityAdoptionV1(f.request);
      throw new Error(
        "Controller admitted state without database verification",
      );
    } catch (error) {
      if (!(error instanceof OmnyoStateWorkPendingError)) throw error;

      if (error.progress.phase === "database-verification") {
        pending = true;
        break;
      }
    }
  }

  expect(pending).toBe(true);
  expect(
    JSON.parse(
      await readFile(join(f.input.jobDir, "root-adoption.json"), "utf8"),
    ),
  ).toMatchObject({
    phase: "converted",
    databaseVerification: "release-producer-v1",
  });
  await expect(stat(f.input.destinationDataDir)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    stat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const result = await databaseCli({
    phase: "verify-database",
    request: f.request,
  });

  expect(result).toMatchObject({
    version: 2,
    verified: true,
    capacityOnly: false,
    migrationId: f.request.id,
    artifactDigest: f.request.binding.runtimeSha256,
  });
  expect(result.proofSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    JSON.parse(
      await readFile(join(f.input.jobDir, "root-adoption.json"), "utf8"),
    ),
  ).toMatchObject({
    phase: "converted",
    databaseVerification: "release-producer-v1",
  });
  await expect(
    stat(join(f.input.jobDir, "write-admission.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
