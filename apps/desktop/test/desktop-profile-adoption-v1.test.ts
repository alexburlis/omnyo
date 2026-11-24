import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareDesktopProfilePathV1 } from "../src/desktop-profile-v1.js";
import {
  prepareDesktopProfileAdoptionV1,
  acceptDesktopProfileAdoptionV1,
  rollbackDesktopProfileAdoptionV1,
  inspectDesktopProfileAdoptionTreeV1,
  desktopProfileAdoptionBindingV1,
} from "../src/desktop-profile-adoption-v1.js";

declare module "vitest" {
  interface TaskMeta {
    profileContinuitySourceProbeV2?: {
      sourceProbePresent: boolean;
      copiedProbePresent: boolean;
    };
  }
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "omnyo-profile-adoption-")),
  );

  roots.push(root);
  const appDataPath = join(root, "profiles");
  const source = join(appDataPath, "BB Private");
  await mkdir(join(source, "Partitions/bb-browser/Network"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(source, "Partitions/unknown-user-partition"), {
    recursive: true,
  });
  await writeFile(
    join(source, "Partitions/bb-browser/Network/Cookies"),
    "opaque cookie database",
  );
  await writeFile(
    join(source, "Partitions/unknown-user-partition/user-work"),
    "unknown Chromium state",
  );
  await writeFile(
    join(source, "connect-credential.bin"),
    "opaque encrypted value",
    { mode: 0o600 },
  );
  const owner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = owner.pid;
  await once(owner, "exit");

  if (pid === undefined) throw new Error("fixture owner missing");

  const nativeOwner = {
    appId: "profile.fixture",
    storageName: "profile fixture",
    executableSha256: "a".repeat(64),
    profileFenceVersion: 1 as const,
  };

  const input = {
    version: 1 as const,
    applicationName: "Omnyo Private" as const,
    appDataPath,
    jobDir: join(root, "job"),
    stoppedOwnerPid: pid,
    nativeOwner,
  };

  const owners = {
    async verifyNativeOwner() {
      return nativeOwner;
    },
    async verifyContinuity(probe: string) {
      expect(
        await readFile(
          join(probe, "Partitions/omnyo-browser/Network/Cookies"),
          "utf8",
        ),
      ).toBe("opaque cookie database");
      expect(
        await readFile(join(probe, "connect-credential.bin"), "utf8"),
      ).toBe("opaque encrypted value");
      await writeFile(join(probe, "probe-only-write"), "isolated probe");

      return {
        protectedStore: true as const,
        cookies: true as const,
        nativeOwnerSha256: createHash("sha256")
          .update(JSON.stringify(nativeOwner))
          .digest("hex"),
      };
    },
  };

  const startup = () =>
    prepareDesktopProfilePathV1({
      appDataPath,
      applicationName: "Omnyo Private",
      explicitUserDataPath: null,
    });

  return {
    root,
    source,
    input,
    owners,
    startup,
    target: join(appDataPath, "Omnyo Private"),
  };
}

test("binds the producer selection to the actual profile owner independently of JSON property order", async () => {
  const f = await fixture();
  const { nativeOwner, ...rest } = f.input;

  const reordered = {
    nativeOwner: {
      profileFenceVersion: nativeOwner.profileFenceVersion,
      executableSha256: nativeOwner.executableSha256,
      storageName: nativeOwner.storageName,
      appId: nativeOwner.appId,
    },
    ...rest,
  };

  const selected = desktopProfileAdoptionBindingV1(reordered);
  const unknownInput = { ...reordered, unknown: true };

  const unknownOwner = {
    ...reordered,
    nativeOwner: { ...reordered.nativeOwner, unknown: true },
  };

  expect(selected).toBe(
    createHash("sha256").update(JSON.stringify(f.input)).digest("hex"),
  );
  expect(() => desktopProfileAdoptionBindingV1(unknownInput)).toThrow();
  expect(() => desktopProfileAdoptionBindingV1(unknownOwner)).toThrow();

  await prepareDesktopProfileAdoptionV1(reordered, f.owners);

  const journal = JSON.parse(
    await readFile(
      join(f.input.jobDir, "desktop-profile-adoption-v1.json"),
      "utf8",
    ),
  );

  expect(journal.bindingSha256).toBe(selected);
  expect(desktopProfileAdoptionBindingV1(f.input)).toBe(selected);
});

test("adopts every stopped profile byte and unknown partition before admitting the first write", async () => {
  const f = await fixture();
  const before = await inspectDesktopProfileAdoptionTreeV1(f.source);
  await prepareDesktopProfileAdoptionV1(f.input, f.owners);
  expect(f.startup).toThrow("first writes are held");
  expect(await inspectDesktopProfileAdoptionTreeV1(f.source)).toBe(before);
  expect(
    await readFile(
      join(f.target, "Partitions/unknown-user-partition/user-work"),
      "utf8",
    ),
  ).toBe("unknown Chromium state");
  await expect(readFile(join(f.target, "probe-only-write"))).rejects.toThrow();
  await acceptDesktopProfileAdoptionV1(f.input.jobDir);
  expect(f.startup()).toBe(f.target);
  await writeFile(join(f.target, "new-user-work"), "new work after admission");
  expect(f.startup()).toBe(f.target);
  await acceptDesktopProfileAdoptionV1(f.input.jobDir);
  await expect(
    rollbackDesktopProfileAdoptionV1(f.input.jobDir),
  ).rejects.toThrow("after first-write");
  expect(await readFile(join(f.target, "new-user-work"), "utf8")).toBe(
    "new work after admission",
  );
});

test("keeps continuity failure closed, resumes its exact copy and restores pre-write ownership", async () => {
  const f = await fixture();
  await expect(
    prepareDesktopProfileAdoptionV1(f.input, {
      ...f.owners,
      async verifyContinuity() {
        throw new Error("protected store cannot decrypt");
      },
    }),
  ).rejects.toThrow("cannot decrypt");
  expect(f.startup).toThrow();
  await prepareDesktopProfileAdoptionV1(f.input, f.owners);
  await rollbackDesktopProfileAdoptionV1(f.input.jobDir);
  await rollbackDesktopProfileAdoptionV1(f.input.jobDir);
  await expect(
    readFile(join(f.target, "connect-credential.bin")),
  ).rejects.toThrow();
  expect(await readFile(join(f.source, "connect-credential.bin"), "utf8")).toBe(
    "opaque encrypted value",
  );
});

test("refuses a running owner and profile collisions without changing either profile", async () => {
  const f = await fixture();
  await expect(
    prepareDesktopProfileAdoptionV1(
      { ...f.input, stoppedOwnerPid: process.pid },
      f.owners,
    ),
  ).rejects.toThrow("still running");
  await mkdir(f.target);
  await writeFile(join(f.target, "foreign-work"), "independent work");
  await expect(
    prepareDesktopProfileAdoptionV1(f.input, f.owners),
  ).rejects.toThrow("collides");
  expect(await readFile(join(f.target, "foreign-work"), "utf8")).toBe(
    "independent work",
  );
});

test("reconciles a lost verified-copy and publication acknowledgement without repeating native validation", async () => {
  const f = await fixture();
  let calls = 0;

  const owners = {
    ...f.owners,
    async verifyContinuity(path: string) {
      calls++;

      return f.owners.verifyContinuity(path);
    },
  };

  await prepareDesktopProfileAdoptionV1(f.input, owners);
  const path = join(f.input.jobDir, "desktop-profile-adoption-v1.json");
  const journal = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...journal, phase: "publishing" }), {
    mode: 0o600,
  });
  await prepareDesktopProfileAdoptionV1(f.input, owners);
  expect(calls).toBe(1);
  await acceptDesktopProfileAdoptionV1(f.input.jobDir);
  expect(f.startup()).toBe(f.target);
});

test("preserves native file metadata while adopting only the exact owned browser partition", async () => {
  const f = await fixture();
  const execute = promisify(execFile);
  const file = join(f.source, "Partitions/unknown-user-partition/user-work");
  await execute("/usr/bin/xattr", [
    "-w",
    "com.omnyo.fixture",
    "synthetic metadata",
    file,
  ]);
  await execute("/bin/chmod", [
    "+a",
    `user:${userInfo().username} allow read,readattr,readextattr,readsecurity`,
    file,
  ]);

  const acl = (await execute("/bin/ls", ["-lde", file])).stdout
    .split("\n")
    .slice(1)
    .join("\n");

  await prepareDesktopProfileAdoptionV1(f.input, f.owners);
  const copied = join(f.target, "Partitions/unknown-user-partition/user-work");
  expect(
    (await execute("/bin/ls", ["-lde", copied])).stdout
      .split("\n")
      .slice(1)
      .join("\n"),
  ).toBe(acl);
  expect(
    (
      await execute("/usr/bin/xattr", ["-p", "com.omnyo.fixture", copied])
    ).stdout.trim(),
  ).toBe("synthetic metadata");
  expect(
    (
      await execute("/usr/bin/xattr", ["-p", "com.omnyo.fixture", file])
    ).stdout.trim(),
  ).toBe("synthetic metadata");
});

test.each(["complete", "changed"] as const)(
  "recovers the exact prepared clone boundary while preserving %s staged work",
  async (state) => {
    const f = await fixture();
    await prepareDesktopProfileAdoptionV1(f.input, f.owners);
    const stage = join(f.input.jobDir, "profile-staging");
    await rename(f.target, stage);
    await rename(
      join(stage, "Partitions/omnyo-browser"),
      join(stage, "Partitions/bb-browser"),
    );
    await rm(join(stage, "product-profile-v1.json"));
    const path = join(f.input.jobDir, "desktop-profile-adoption-v1.json");
    const journal = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...journal,
        phase: "prepared",
        destinationDigest: null,
        continuity: null,
      }),
      { mode: 0o600 },
    );
    const work = join(stage, "Partitions/unknown-user-partition/user-work");

    if (state === "changed") {
      await writeFile(work, "later independent work");
      await expect(
        prepareDesktopProfileAdoptionV1(f.input, f.owners),
      ).rejects.toThrow("requires explicit reconciliation");
      expect(await readFile(work, "utf8")).toBe("later independent work");

      return;
    }

    await prepareDesktopProfileAdoptionV1(f.input, f.owners);
    await acceptDesktopProfileAdoptionV1(f.input.jobDir);
    expect(f.startup()).toBe(f.target);
    expect(
      await readFile(
        join(f.target, "Partitions/omnyo-browser/Network/Cookies"),
        "utf8",
      ),
    ).toBe("opaque cookie database");
  },
);

declare module "vitest" {
  interface TaskMeta {
    sourceApplicationPreflightV2?: {
      accepted: boolean;
      nativeEffects: 0;
      filesystemEffects: 0;
    };
  }
}

test("requires the original source attestation before producing a replacement profile binding", ({
  task,
}) => {
  const executable = {
    path: "/private/tmp/profile-source-preflight-v2/Transfer.app/Contents/Resources/old-reader",
    sha256: "a".repeat(64),
    codeDirectoryHash: "b".repeat(40),
    designatedRequirement: 'identifier "dev.bb.private"',
  };

  const input = {
    version: 2,
    applicationName: "Omnyo Private",
    appDataPath: "/private/tmp/profile-source-preflight-v2/profiles",
    jobDir: "/private/tmp/profile-source-preflight-v2/job",
    stoppedOwnerPid: 123,
    originWindows: [],
    nativeOwner: {
      appId: "dev.omnyo.private",
      storageName: "Omnyo Private",
      executableSha256: "c".repeat(64),
      profileFenceVersion: 2,
    },
    protectedStoreTransfer: {
      reader: executable,
      writer: {
        ...executable,
        path: "/private/tmp/profile-source-preflight-v2/Transfer.app/Contents/Resources/new-writer",
      },
      job: {
        path: "/private/tmp/profile-source-preflight-v2/Transfer.app",
        selectionSha256: "d".repeat(64),
      },
      oldStorageName: "BB Private",
      sourceApplication: null,
    },
  } satisfies Parameters<typeof desktopProfileAdoptionBindingV1>[0];

  let accepted = false;
  let message = "";

  try {
    desktopProfileAdoptionBindingV1(input);
    accepted = true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    message = error.message;
  }

  task.meta.sourceApplicationPreflightV2 = {
    accepted,
    nativeEffects: 0,
    filesystemEffects: 0,
  };
  expect(accepted).toBe(false);
  expect(message).toContain(
    "Original source application attestation is required before profile preparation",
  );
});

test("binds the original source profile to the selected copy owner", ({
  task,
}) => {
  const executable = {
    path: "/Applications/BB Private VPS.app/Contents/MacOS/BB Private",
    sha256: "a".repeat(64),
    codeDirectoryHash: "b".repeat(40),
    designatedRequirement: 'identifier "dev.bb.private"',
  };

  const input = {
    version: 2,
    applicationName: "Omnyo Private",
    appDataPath: "/private/tmp/profile-source-preflight-v2/profiles",
    jobDir: "/private/tmp/profile-source-preflight-v2/job",
    stoppedOwnerPid: 123,
    originWindows: [],
    nativeOwner: {
      appId: "dev.omnyo.private",
      storageName: "Omnyo Private",
      executableSha256: "c".repeat(64),
      profileFenceVersion: 2,
    },
    protectedStoreTransfer: {
      reader: {
        ...executable,
        path: "/private/tmp/profile-source-preflight-v2/Transfer.app/Contents/Resources/old-reader",
      },
      writer: {
        ...executable,
        path: "/private/tmp/profile-source-preflight-v2/Transfer.app/Contents/Resources/new-writer",
      },
      job: {
        path: "/private/tmp/profile-source-preflight-v2/Transfer.app",
        selectionSha256: "d".repeat(64),
      },
      oldStorageName: "BB Private",
      sourceApplication: {
        appPath: "/Applications/BB Private VPS.app",
        profilePath: "/private/tmp/another-profile-owner/BB Private",
        executable,
        originalMode: 0o755,
        device: "1",
        inode: "2",
      },
    },
  } satisfies Parameters<typeof desktopProfileAdoptionBindingV1>[0];

  let accepted = false;
  let message = "";

  try {
    desktopProfileAdoptionBindingV1(input);
    accepted = true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    message = error.message;
  }

  task.meta.sourceApplicationPreflightV2 = {
    accepted,
    nativeEffects: 0,
    filesystemEffects: 0,
  };
  expect(accepted).toBe(false);
  expect(message).toContain(
    "Original source application attestation is required before profile preparation",
  );
});

test("binds an untouched source-layout continuity copy beside the migrated probe and removes both", async ({
  task,
}) => {
  const f = await fixture();
  const before = await inspectDesktopProfileAdoptionTreeV1(f.source);
  const sourceProbe = join(f.input.jobDir, "profile-source-probe");
  await prepareDesktopProfileAdoptionV1(f.input, {
    ...f.owners,
    async verifyContinuity(probe: string) {
      async function present(path: string) {
        try {
          await readFile(path);

          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return false;

          throw error;
        }
      }

      const [sourceProbePresent, copiedProbePresent] = await Promise.all([
        present(join(sourceProbe, "Partitions/bb-browser/Network/Cookies")),
        present(join(probe, "Partitions/omnyo-browser/Network/Cookies")),
      ]);

      task.meta.profileContinuitySourceProbeV2 = {
        sourceProbePresent,
        copiedProbePresent,
      };

      expect(sourceProbePresent).toBe(true);
      expect(copiedProbePresent).toBe(true);
      expect(await inspectDesktopProfileAdoptionTreeV1(sourceProbe)).toBe(
        before,
      );
      expect(
        await readFile(
          join(sourceProbe, "Partitions/bb-browser/Network/Cookies"),
          "utf8",
        ),
      ).toBe("opaque cookie database");
      expect(
        await readFile(
          join(probe, "Partitions/omnyo-browser/Network/Cookies"),
          "utf8",
        ),
      ).toBe("opaque cookie database");

      return f.owners.verifyContinuity(probe);
    },
  });
  expect(await inspectDesktopProfileAdoptionTreeV1(f.source)).toBe(before);
  await expect(
    readFile(join(sourceProbe, "connect-credential.bin")),
  ).rejects.toThrow();
});
