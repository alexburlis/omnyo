import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("runs stopped-profile admission through the actual built standalone helper and shipped runtime dependency closure", async ({
  task,
}) => {
  const artifact = join(__dirname, "../dist/desktop-profile-adoption-v1.cjs");
  const bytes = await readFile(artifact);
  task.meta.artifact = {
    path: artifact,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const loaded: unknown = createRequire(__filename)(artifact);

  if (
    loaded === null ||
    typeof loaded !== "object" ||
    !("prepareDesktopProfileAdoptionV1" in loaded) ||
    typeof loaded.prepareDesktopProfileAdoptionV1 !== "function" ||
    !("acceptDesktopProfileAdoptionV1" in loaded) ||
    typeof loaded.acceptDesktopProfileAdoptionV1 !== "function" ||
    !("inspectDesktopProfileAdoptionTreeV1" in loaded) ||
    typeof loaded.inspectDesktopProfileAdoptionTreeV1 !== "function"
  )
    throw new Error("Built profile helper lacks the actual producer contract");

  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-built-profile-")),
  );

  try {
    const appDataPath = join(root, "profiles");
    const source = join(appDataPath, "BB Private");
    await mkdir(join(source, "Partitions/bb-browser"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(source, "opaque-work"), "unchanged user work");

    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
    });

    const pid = child.pid;
    await once(child, "close");

    if (pid === undefined)
      throw new Error("Isolated stopped fixture owner was not created");

    const nativeOwner = {
      appId: "built-profile-fixture",
      storageName: "synthetic fixture",
      executableSha256: "a".repeat(64),
      profileFenceVersion: 1,
    };

    const input = {
      version: 1,
      applicationName: "Omnyo Private",
      appDataPath,
      jobDir: join(root, "job"),
      stoppedOwnerPid: pid,
      nativeOwner,
    };

    const before: unknown =
      await loaded.inspectDesktopProfileAdoptionTreeV1(source);

    await loaded.prepareDesktopProfileAdoptionV1(input, {
      async verifyNativeOwner() {
        return nativeOwner;
      },
      async verifyContinuity(probe: string) {
        expect(await readFile(join(probe, "opaque-work"), "utf8")).toBe(
          "unchanged user work",
        );

        return {
          protectedStore: true,
          cookies: true,
          nativeOwnerSha256: createHash("sha256")
            .update(JSON.stringify(nativeOwner))
            .digest("hex"),
        };
      },
    });
    expect(
      await readFile(join(input.jobDir, "desktop-profile-admission"), "utf8"),
    ).toBe("0");
    await loaded.acceptDesktopProfileAdoptionV1(input.jobDir);
    expect(
      await readFile(join(input.jobDir, "desktop-profile-admission"), "utf8"),
    ).toBe("1");
    expect(await loaded.inspectDesktopProfileAdoptionTreeV1(source)).toBe(
      before,
    );
    expect(
      await readFile(join(appDataPath, "Omnyo Private/opaque-work"), "utf8"),
    ).toBe("unchanged user work");
  } finally {
    await rm(root, { recursive: true });
  }
});
