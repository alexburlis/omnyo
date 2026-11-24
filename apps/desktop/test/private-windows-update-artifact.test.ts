import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { createPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";
import {
  inspectDownloadedPrivateWindowsUpdate,
  inspectInstalledPrivateWindowsUpdate,
} from "../src/private-windows-update-artifact.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

function zip(entries: { path: string; bytes: Buffer }[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(entry.bytes), 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc32(entry.bytes), 16);
    header.writeUInt32LE(entry.bytes.length, 20);
    header.writeUInt32LE(entry.bytes.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.bytes);
    central.push(header, name);
    offset += local.length + name.length + entry.bytes.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

async function fixture(
  root: string,
  change?: "tamper" | "identity" | "protocol",
  version = "0.46.3+private.1",
) {
  const numeric = version.split("+")[0]!;
  const protocol = change === "protocol" ? 234 : 236;
  const app = join(root, "app");
  await mkdir(app);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "omnyo-private", version }),
  );
  const asar = join(root, "app.asar");
  await createPackage(app, asar);

  const payloads = [
    {
      path: "package.json",
      bytes: Buffer.from(JSON.stringify({ name: "omnyo-app", version })),
    },
    {
      path: "dist/omnyo-app.js",
      bytes: Buffer.from("export const inert=true;"),
    },
    {
      path: "server/dist/index.js",
      bytes: Buffer.from("export const inert=true;"),
    },
    {
      path: "host-daemon/dist/index.js",
      bytes: Buffer.from("export const inert=true;"),
    },
    { path: "app/dist/index.html", bytes: Buffer.from("<title>Inert</title>") },
  ];

  const files = payloads
    .map(({ path, bytes }) => ({ path, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));

  const runtimeSha256 = hash(JSON.stringify(files));
  const executable = Buffer.from("MZ inert fixture; never executable");
  const desktopSha256 = hash(await readFile(asar));

  const metadata = {
    schema: 1,
    appId: change === "identity" ? "dev.omnyo.other" : "dev.omnyo.private",
    version: numeric,
    runtimeVersion: version,
    protocolVersion: protocol,
    runtimeSha256,
    executable: "Omnyo.exe",
    executableSha256: hash(executable),
    desktopSha256,
  };

  const identity = {
    schemaVersion: 1,
    runtimeVersion: version,
    hostDaemonProtocolVersion: protocol,
    runtimeSha256,
    files,
  };

  if (change === "tamper") payloads[1]!.bytes = Buffer.from("changed source");

  const entries = [
    { path: "Omnyo.exe", bytes: executable },
    { path: "resources/app.asar", bytes: await readFile(asar) },
    {
      path: "resources/private-update-identity.json",
      bytes: Buffer.from(JSON.stringify(metadata)),
    },
    {
      path: "resources/app.asar.unpacked/node_modules/omnyo-app/dist/runtime-identity.json",
      bytes: Buffer.from(JSON.stringify(identity)),
    },
    ...payloads.map((entry) => ({
      ...entry,
      path: "resources/app.asar.unpacked/node_modules/omnyo-app/" + entry.path,
    })),
  ];

  const archive = zip(entries);

  const bytes = Buffer.concat([
    Buffer.from("MZ inert NSIS header"),
    archive,
    Buffer.from("inert NSIS footer"),
  ]);

  const file = join(root, "private.exe");
  await writeFile(file, bytes);

  return {
    entries,
    file,
    release: {
      version: numeric,
      releaseDate: "2026-10-14T00:00:00.000Z",
      files: [
        {
          url: "private.exe",
          size: bytes.length,
          sha512: createHash("sha512").update(bytes).digest("base64"),
        },
      ],
      omnyoPrivate: {
        appId: "dev.omnyo.private",
        teamId: "",
        platform: "windows" as const,
        runtimeVersion: version,
        protocolVersion: protocol,
        runtimeSha256,
        desktopSha256,
        executableSha256: metadata.executableSha256,
      },
    },
  };
}

describe("private Windows NSIS payload boundary", () => {
  it.each([undefined, "tamper", "identity", "protocol"] as const)(
    "inspects embedded bytes without executing the candidate (%s)",
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-windows-payload-"));

      try {
        const { file, release } = await fixture(root, change);

        const result = inspectDownloadedPrivateWindowsUpdate({
          file,
          release,
          currentVersion: "0.46.2+private.3",
          expectedAppId: "dev.omnyo.private",
          expectedProtocolVersion: 235,
        });

        if (change) await expect(result).rejects.toThrow("Private Windows");
        else
          await expect(result).resolves.toMatchObject({
            runtimeVersion: "0.46.3+private.1",
            protocolVersion: 236,
            teamId: "",
          });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("verifies the runtime the installer ships both before and after installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-windows-payload-"));

    try {
      const { entries, file, release } = await fixture(root);

      await expect(
        inspectDownloadedPrivateWindowsUpdate({
          file,
          release,
          currentVersion: "0.46.2+private.3",
          expectedAppId: "dev.omnyo.private",
          expectedProtocolVersion: 235,
        }),
      ).resolves.toMatchObject({
        runtimeSha256: release.omnyoPrivate.runtimeSha256,
      });

      const appRoot = join(root, "installed");

      for (const entry of entries) {
        const path = join(appRoot, entry.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, entry.bytes);
      }

      await expect(
        inspectInstalledPrivateWindowsUpdate(appRoot),
      ).resolves.toMatchObject({
        runtimeSha256: release.omnyoPrivate.runtimeSha256,
        runtimeVersion: "0.46.3+private.1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["1.0.0+private.1", "0.46.379+private.1"],
    ["1.0.1", "1.0.0+private.1"],
  ])(
    "verifies a %s installer over %s before and after installation",
    async (version, currentVersion) => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-windows-payload-"));

      try {
        const { entries, file, release } = await fixture(
          root,
          undefined,
          version,
        );

        await expect(
          inspectDownloadedPrivateWindowsUpdate({
            file,
            release,
            currentVersion,
            expectedAppId: "dev.omnyo.private",
            expectedProtocolVersion: 236,
          }),
        ).resolves.toMatchObject({ runtimeVersion: version });

        const appRoot = join(root, "installed");

        for (const entry of entries) {
          const path = join(appRoot, entry.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, entry.bytes);
        }

        await expect(
          inspectInstalledPrivateWindowsUpdate(appRoot),
        ).resolves.toMatchObject({ runtimeVersion: version });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
