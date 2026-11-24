import { jsonObjectSchema, type JsonObject } from "@omnyo/domain";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { upsertInstalledPlugin } from "@omnyo/db";
import { listBundledPluginRegistrations } from "../../../../apps/server/src/services/plugins/builtin-registry.js";
import { readPluginManifest } from "../../../../apps/server/src/services/plugins/manifest.js";
import type { TestAppHarness } from "../../../../apps/server/test/helpers/test-app.js";

const require = createRequire(import.meta.url);

const startServerUrl = new URL(
  "../../../../apps/server/src/start-server.ts",
  import.meta.url,
).href;

const configUrl = new URL(
  "../../../../packages/config/src/server.ts",
  import.meta.url,
).href;

export type FixtureJson = JsonObject;

export async function readJsonIfPresent(
  path: string,
): Promise<FixtureJson | null> {
  try {
    return jsonObjectSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function writeInertPlugin(
  dataDir: string,
  name: string,
  serverSource: string,
): Promise<string> {
  const root = join(dataDir, "plugins", "cache", "inert-plugin-inputs", name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: `omnyo-plugin-${name}`,
      version: "0.1.0",
      omnyo: {
        name,
        description: "Owned inert migration fixture",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(root, "server.ts"), serverSource);

  return root;
}

export async function disableBundledOwners(
  harness: TestAppHarness,
): Promise<void> {
  for (const bundled of listBundledPluginRegistrations()) {
    const manifest = await readPluginManifest(bundled.rootDir);
    upsertInstalledPlugin(harness.db, {
      id: manifest.id,
      source: `builtin:${bundled.name}`,
      provenance: { kind: "builtin" },
      sourceIntent: { kind: "builtin", name: bundled.name },
      exactResolution: { kind: "builtin" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: bundled.rootDir,
      version: manifest.version,
      enabled: false,
      enabledFollowsDefault: false,
    });
  }
}

export interface OwnedServerProcess {
  child: ChildProcess;
  baseUrl: string;
  output(): string;
  stop(): Promise<void>;
}

export async function launchOwnedServer(args: {
  dataDir: string;
  port: number;
  startServerUrl?: string;
  detached?: boolean;
  launchId?: string;
}): Promise<OwnedServerProcess> {
  const homeDir = join(args.dataDir, "inert-home");
  await mkdir(homeDir, { recursive: true });

  const configEnv = {
    NODE_ENV: "production",
    OMNYO_DATA_DIR: args.dataDir,
    OMNYO_SERVER_PORT: String(args.port),
    OMNYO_SERVER_BIND_HOST: "127.0.0.1",
    OMNYO_HOST_DAEMON_PORT: "39990",
    OMNYO_TELEMETRY: "false",
  };

  if (args.launchId !== undefined)
    Object.assign(configEnv, { OMNYO_SERVER_LAUNCH_ID: args.launchId });

  const script = `
    import { loadServerConfig } from ${JSON.stringify(configUrl)};
    import { runServer } from ${JSON.stringify(args.startServerUrl ?? startServerUrl)};
    const config = loadServerConfig({ env: ${JSON.stringify(configEnv)}, homeDir: ${JSON.stringify(homeDir)}, mode: "production" });
    await runServer(config);
  `;

  const inputPath = join(args.dataDir, "inert-owned-server-entry.mjs");
  await writeFile(inputPath, script);

  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", require.resolve("tsx"), inputPath],
    {
      detached: args.detached ?? false,
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", HOME: homeDir, ...configEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout?.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-32_000);
  });
  child.stderr?.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-32_000);
  });
  let exited = child.exitCode !== null;

  const finished = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );

  const baseUrl = `http://127.0.0.1:${args.port}`;

  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await Promise.race([finished, sleep(5_000)]);

    if (!exited) {
      child.kill("SIGKILL");
      await finished;
    }
  };

  try {
    const deadline = Date.now() + 15_000;
    let healthy = false;

    while (Date.now() < deadline) {
      if (exited)
        throw new Error(`Owned fixture server exited before health: ${output}`);

      try {
        healthy =
          (
            await fetch(`${baseUrl}/health`, {
              signal: AbortSignal.timeout(300),
            })
          ).status === 200;
      } catch {
        healthy = false;
      }

      if (healthy) break;
      await sleep(50);
    }

    if (!healthy)
      throw new Error(`Owned fixture server never became healthy: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }

  return { child, baseUrl, output: () => output, stop };
}
