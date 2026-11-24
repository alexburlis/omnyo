import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  prepareDesktopProfileAdoptionV1,
  acceptDesktopProfileAdoptionV1,
  inspectDesktopProfileAdoptionTreeV1,
} from "../src/desktop-profile-adoption-v1.js";
import { prepareDesktopProfilePathV1 } from "../src/desktop-profile-v1.js";

const execute = promisify(execFile);

const nativeReportSchema = z.object({
  seed: z.boolean().optional(),
  protectedStore: z.boolean().optional(),
  cookies: z.boolean().optional(),
  unknownCookies: z.boolean().optional(),
  executableSha256: z.string().optional(),
  storageName: z.string().optional(),
  pid: z.number().int().positive(),
});

test("preserves real safeStorage decryption and encrypted Chromium cookies under the same native owner", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-native-profile-")),
  );

  try {
    const electron = z.string().parse(createRequire(__filename)("electron"));

    const appDataPath = join(root, "profiles");
    const source = join(appDataPath, "BB Private");
    await mkdir(join(source, "Partitions/unknown-fixture"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(source, "Partitions/unknown-fixture/unknown-user-state"),
      "unknown native profile work",
    );

    const script = join(
      __dirname,
      "fixtures/desktop-profile-continuity-v1.cjs",
    );

    const storageModule = join(root, "storage-owner.cjs");
    await build({
      entryPoints: [join(__dirname, "../src/desktop-profile-storage-v1.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: storageModule,
      logLevel: "silent",
    });
    let count = 0;

    async function native(mode: "seed" | "verify", profile: string) {
      const config = join(root, `config-${++count}.json`);
      const report = join(root, `report-${count}.json`);
      await writeFile(
        config,
        JSON.stringify({
          mode,
          profile,
          report,
          applicationName:
            mode === "seed"
              ? "Omnyo Profile Legacy Fixture"
              : "Omnyo Profile Current Fixture",
          storageName: "Omnyo Profile Legacy Fixture",
          storageModule,
        }),
        {
          mode: 0o600,
        },
      );
      await execute(electron, [script, config], {
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
        },
      });

      return nativeReportSchema.parse(
        JSON.parse(await readFile(report, "utf8")),
      );
    }

    const seeded = await native("seed", source);
    expect(seeded.seed).toBe(true);
    const before = await inspectDesktopProfileAdoptionTreeV1(source);

    const nativeOwner = {
      appId: "com.github.Electron",
      storageName: "Omnyo Profile Legacy Fixture",
      executableSha256: createHash("sha256")
        .update(await readFile(electron))
        .digest("hex"),
      profileFenceVersion: 1 as const,
    };

    const input = {
      version: 1 as const,
      applicationName: "Omnyo Private" as const,
      appDataPath,
      jobDir: join(root, "job"),
      stoppedOwnerPid: seeded.pid,
      nativeOwner,
    };

    await prepareDesktopProfileAdoptionV1(input, {
      async verifyNativeOwner() {
        return nativeOwner;
      },
      async verifyContinuity(probe) {
        const result = await native("verify", probe);
        expect(result.protectedStore).toBe(true);
        expect(result.cookies).toBe(true);
        expect(result.unknownCookies).toBe(true);
        expect(result.executableSha256).toBe(nativeOwner.executableSha256);
        expect(result.storageName).toBe(nativeOwner.storageName);

        return {
          protectedStore: true,
          cookies: true,
          nativeOwnerSha256: createHash("sha256")
            .update(JSON.stringify(nativeOwner))
            .digest("hex"),
        };
      },
    });
    expect(await inspectDesktopProfileAdoptionTreeV1(source)).toBe(before);
    expect(() =>
      prepareDesktopProfilePathV1({
        appDataPath,
        applicationName: "Omnyo Private",
        explicitUserDataPath: null,
      }),
    ).toThrow("first writes are held");
    await acceptDesktopProfileAdoptionV1(input.jobDir);

    const target = prepareDesktopProfilePathV1({
      appDataPath,
      applicationName: "Omnyo Private",
      explicitUserDataPath: null,
    });

    expect(
      await readFile(
        join(target, "Partitions/unknown-fixture/unknown-user-state"),
        "utf8",
      ),
    ).toBe("unknown native profile work");
    await writeFile(
      join(target, "first-admitted-write"),
      "post-admission work",
    );
    expect(await inspectDesktopProfileAdoptionTreeV1(source)).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
