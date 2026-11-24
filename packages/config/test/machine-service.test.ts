import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMachineServiceFile } from "../src/machine-service.js";

interface InstallerGeneration {
  dataDirEnvName: string;
  launchdPrefix: string;
  name: string;
  npmPrefixEnvName: string;
  runtime: string;
  systemdPrefix: string;
}

const currentInstaller: InstallerGeneration = {
  dataDirEnvName: "OMNYO_DATA_DIR",
  launchdPrefix: "app.omnyo.host-daemon.",
  name: "the current installer",
  npmPrefixEnvName: "OMNYO_APP_NPM_PREFIX",
  runtime: "/opt/omnyo-app",
  systemdPrefix: "omnyo-host-daemon-",
};

const tempDirs: string[] = [];

async function createRoot(): Promise<{ dataDir: string; homeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-machine-service-"));
  tempDirs.push(root);
  const homeDir = join(root, "home");
  const dataDir = join(root, "data & more");
  await mkdir(homeDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  return { dataDir, homeDir };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

async function writeLaunchAgent(args: {
  dataDir: string;
  generation: InstallerGeneration;
  homeDir: string;
  name: string;
}): Promise<string> {
  const directory = join(args.homeDir, "Library", "LaunchAgents");
  await mkdir(directory, { recursive: true });
  const path = join(directory, args.name);
  await writeFile(
    path,
    `<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${args.generation.npmPrefixEnvName}</key><string>${xmlEscape(args.dataDir)}/npm</string>
    <key>${args.generation.dataDirEnvName}</key><string>${xmlEscape(args.dataDir)}</string>
  </dict>
</dict>
</plist>
`,
  );

  return path;
}

async function writeSystemdUnit(args: {
  dataDir: string;
  directory: string;
  generation: InstallerGeneration;
  name: string;
}): Promise<string> {
  await mkdir(args.directory, { recursive: true });
  const path = join(args.directory, args.name);
  await writeFile(
    path,
    `[Service]
ExecStart="/usr/bin/node" "${args.generation.runtime}" host-daemon --auto-update
Environment="${args.generation.npmPrefixEnvName}=${systemdEscape(args.dataDir)}/npm"
Environment="${args.generation.dataDirEnvName}=${systemdEscape(args.dataDir)}"
`,
  );

  return path;
}

afterEach(async () => {
  for (const root of tempDirs.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe.each([currentInstaller])(
  "findMachineServiceFile with services from $name",
  (generation) => {
    it("finds the launch agent that runs a daemon for the data directory", async () => {
      const { dataDir, homeDir } = await createRoot();
      await writeLaunchAgent({
        dataDir: join(dataDir, "..", "other"),
        generation,
        homeDir,
        name: `${generation.launchdPrefix}a-other.plist`,
      });

      const expected = await writeLaunchAgent({
        dataDir,
        generation,
        homeDir,
        name: `${generation.launchdPrefix}b-machine.plist`,
      });

      await writeLaunchAgent({
        dataDir,
        generation,
        homeDir,
        name: "com.example.unrelated.plist",
      });

      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
      ).resolves.toBe(expected);
    });

    it("matches a service that names the data directory through a symlink", async () => {
      const { dataDir, homeDir } = await createRoot();
      const linkedDataDir = join(homeDir, "linked-data");
      await symlink(dataDir, linkedDataDir);

      const expected = await writeLaunchAgent({
        dataDir: linkedDataDir,
        generation,
        homeDir,
        name: `${generation.launchdPrefix}machine.plist`,
      });

      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
      ).resolves.toBe(expected);
    });

    it("finds systemd user and system units that run a daemon for the data directory", async () => {
      const { dataDir, homeDir } = await createRoot();

      const escapedDataDir = join(
        dataDir,
        process.platform === "win32"
          ? "with 'quotes' 100%"
          : 'with "quotes" 100%',
      );

      await mkdir(escapedDataDir, { recursive: true });

      const userUnit = await writeSystemdUnit({
        dataDir: escapedDataDir,
        directory: join(homeDir, ".config", "systemd", "user"),
        generation,
        name: `${generation.systemdPrefix}machine.service`,
      });

      const systemUnit = await writeSystemdUnit({
        dataDir,
        directory: join(dataDir, "systemd"),
        generation,
        name: `${generation.systemdPrefix}machine.service`,
      });

      await expect(
        findMachineServiceFile({
          dataDir: escapedDataDir,
          homeDir,
          platform: "linux",
        }),
      ).resolves.toBe(userUnit);
      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "linux" }),
      ).resolves.toBe(systemUnit);
    });

    it("returns null when no service runs a daemon for the data directory", async () => {
      const { dataDir, homeDir } = await createRoot();

      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
      ).resolves.toBeNull();
      await writeLaunchAgent({
        dataDir: join(homeDir, "elsewhere"),
        generation,
        homeDir,
        name: `${generation.launchdPrefix}elsewhere.plist`,
      });
      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
      ).resolves.toBeNull();
      await expect(
        findMachineServiceFile({ dataDir, homeDir, platform: "win32" }),
      ).resolves.toBeNull();
    });
  },
);
