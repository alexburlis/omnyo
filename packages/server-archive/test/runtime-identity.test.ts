import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeIdentity,
  runtimeIdentityDigest,
  verifyInstalledLegacyRuntimeIdentityV1,
  readInstalledLegacyRuntimeIdentityV1,
  verifyRuntimeIdentity,
  createWorkerRuntimeIdentity,
  verifyWorkerRuntimeIdentity,
} from "../src/runtime-identity.js";
import {
  legacyFullPackageRoleV1,
  legacyWorkerPackageRoleV1,
} from "../src/legacy-runtime-identity-v1.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(runtimeVersion = "0.46.238+private.1") {
  const root = await mkdtemp(join(tmpdir(), "omnyo-runtime-identity-"));
  roots.push(root);

  for (const path of ["dist", "server/dist", "host-daemon/dist", "app/dist"]) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "entry.js"), "export default 1;\n");
  }

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: runtimeVersion }),
  );

  const identity = await createRuntimeIdentity(root, {
    runtimeVersion,
    hostDaemonProtocolVersion: 252,
  });

  return { root, identity };
}

it.each([
  "0.46.238+private.1",
  "0.46.241+private.1",
  "0.46.242+private.1",
  "0.46.245+private.1",
])(
  "produces only canonical runtime identities while the finite installed legacy decoder remains read only on %s",
  async (runtimeVersion) => {
    const f = await fixture(runtimeVersion);
    await expect(verifyRuntimeIdentity(f.root, f.identity)).resolves.toEqual(
      f.identity,
    );
    await expect(
      readInstalledLegacyRuntimeIdentityV1(f.root, {
        hostDaemonProtocolVersion: 252,
        runtimeVersion: f.identity.runtimeVersion,
      }),
    ).rejects.toThrow(/package version/);
    await writeFile(
      join(f.root, "package.json"),
      JSON.stringify({
        name: "bb-app",
        version: runtimeVersion,
        ...legacyFullPackageRoleV1,
      }),
    );
    const bytes = await readFile(join(f.root, "package.json"));

    const files = f.identity.files.map((file) =>
      file.path === "package.json"
        ? { ...file, sha256: createHash("sha256").update(bytes).digest("hex") }
        : file,
    );

    const legacy = {
      ...f.identity,
      files,
      runtimeSha256: runtimeIdentityDigest(files),
    };

    await expect(
      readInstalledLegacyRuntimeIdentityV1(f.root, {
        hostDaemonProtocolVersion: 252,
        runtimeVersion: f.identity.runtimeVersion,
      }),
    ).resolves.toEqual(legacy);
    await expect(createRuntimeIdentity(f.root, legacy)).rejects.toThrow(
      /package version/,
    );
    await expect(verifyRuntimeIdentity(f.root, legacy)).rejects.toThrow(
      /package version/,
    );
    await expect(
      verifyInstalledLegacyRuntimeIdentityV1(f.root, legacy),
    ).resolves.toEqual(legacy);
    await expect(
      verifyInstalledLegacyRuntimeIdentityV1(f.root, {
        ...legacy,
        hostDaemonProtocolVersion: 253,
      }),
    ).rejects.toThrow(/package version/);
    await writeFile(join(f.root, "dist/entry.js"), "changed bytes\n");
    await expect(
      verifyInstalledLegacyRuntimeIdentityV1(f.root, legacy),
    ).rejects.toThrow(
      /^Legacy runtime identity inventory digest mismatch \(missing 0, extra 0, changed 1; changed: dist\/entry\.js\)$/,
    );
    await expect(
      verifyInstalledLegacyRuntimeIdentityV1(f.root, {
        ...legacy,
        runtimeVersion: "0.46.239+private.1",
      }),
    ).rejects.toThrow(/Unsupported legacy/);
  },
);

it("reads only the positively declared finite V1 worker role without inventing server or app roots", async () => {
  const f = await fixture();
  await rm(join(f.root, "server"), { recursive: true });
  await rm(join(f.root, "app"), { recursive: true });
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({
      name: "bb-app",
      version: "0.46.238+private.1",
      ...legacyWorkerPackageRoleV1,
    }),
  );
  const before = await readFile(join(f.root, "package.json"));

  const identity = await readInstalledLegacyRuntimeIdentityV1(f.root, {
    hostDaemonProtocolVersion: 252,
  });

  expect(identity.files.map((file) => file.path)).toEqual([
    "dist/entry.js",
    "host-daemon/dist/entry.js",
    "package.json",
  ]);
  await expect(
    verifyInstalledLegacyRuntimeIdentityV1(f.root, identity),
  ).resolves.toEqual(identity);
  expect(await readFile(join(f.root, "package.json"))).toEqual(before);
  await mkdir(join(f.root, "server"));
  await expect(
    readInstalledLegacyRuntimeIdentityV1(f.root, {
      hostDaemonProtocolVersion: 252,
      runtimeVersion: f.identity.runtimeVersion,
    }),
  ).rejects.toThrow("mixed product roots");
  await rm(join(f.root, "server"), { recursive: true });
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "bb-app", version: "0.46.238+private.1" }),
  );
  await expect(
    readInstalledLegacyRuntimeIdentityV1(f.root, {
      hostDaemonProtocolVersion: 252,
      runtimeVersion: f.identity.runtimeVersion,
    }),
  ).rejects.toThrow();
});

it("creates and verifies only a declared canonical worker with its state helper and bound private SDK archive", async () => {
  const f = await fixture();
  await rm(join(f.root, "server"), { recursive: true });
  await rm(join(f.root, "app"), { recursive: true });

  const bin = {
    omnyo: "dist/omnyo.js",
    "omnyo-app": "dist/omnyo-app.js",
    "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
  };

  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({
      name: "omnyo-app",
      version: "0.46.244+private.1",
      files: ["dist", "host-daemon", "README.md"],
      bin,
    }),
  );

  for (const path of [
    ...Object.values(bin),
    "dist/machine-state.mjs",
    "host-daemon/dist/daemon-bundle.mjs",
  ])
    await writeFile(join(f.root, path), "export default 1;\n");
  const archive = Buffer.from("fixture private SDK archive");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const file = `omnyo-plugin-sdk-0.6.44-${sha256.slice(0, 12)}.tgz`;
  await mkdir(join(f.root, "dist/plugin-sdk"));
  await writeFile(join(f.root, "dist/plugin-sdk", file), archive);
  await writeFile(
    join(f.root, "dist/plugin-sdk/manifest.json"),
    JSON.stringify({
      schema: 1,
      packageName: "@omnyo/plugin-sdk",
      version: "0.6.44",
      file,
      sha256,
    }),
  );

  const identity = await createWorkerRuntimeIdentity(f.root, {
    runtimeVersion: "0.46.244+private.1",
    hostDaemonProtocolVersion: 253,
  });

  expect(
    identity.files.some((entry) => entry.path === "dist/machine-state.mjs"),
  ).toBe(true);
  await expect(verifyWorkerRuntimeIdentity(f.root, identity)).resolves.toEqual(
    identity,
  );
  await expect(createRuntimeIdentity(f.root, identity)).rejects.toThrow();
  await writeFile(join(f.root, "dist/plugin-sdk", file), "tampered");
  await expect(verifyWorkerRuntimeIdentity(f.root, identity)).rejects.toThrow(
    "SDK archive differs",
  );
  await writeFile(join(f.root, "dist/plugin-sdk", file), archive);
  await writeFile(join(f.root, "dist/machine-state.mjs"), "drifted\n");
  await expect(verifyWorkerRuntimeIdentity(f.root, identity)).rejects.toThrow(
    /^Worker runtime inventory digest mismatch \(missing 0, extra 0, changed 1; changed: dist\/machine-state\.mjs\)$/,
  );
  await writeFile(
    join(f.root, "dist/machine-state.mjs"),
    "export default 1;\n",
  );
  await mkdir(join(f.root, "server"));
  await expect(createWorkerRuntimeIdentity(f.root, identity)).rejects.toThrow(
    "mixed product roots",
  );
});

it("summarizes missing, extra and changed paths when the inventory digest differs", async () => {
  const f = await fixture();

  for (let index = 0; index < 7; index += 1)
    await writeFile(join(f.root, "dist", `late-${index}.js`), "late\n");
  const withLate = await createRuntimeIdentity(f.root, f.identity);

  await rm(join(f.root, "dist/late-0.js"));
  await rm(join(f.root, "dist/late-1.js"));
  await writeFile(join(f.root, "server/dist/entry.js"), "changed\n");
  await writeFile(join(f.root, "dist/new.js"), "new\n");

  const failure = await verifyRuntimeIdentity(f.root, withLate).then(
    () => null,
    (error: Error) => error.message,
  );

  expect(failure).toMatch(/^Runtime identity inventory digest mismatch \(/);
  expect(failure).toContain("missing 2, extra 1, changed 1");
  expect(failure).toContain("missing: dist/late-0.js, dist/late-1.js");
  expect(failure).toContain("extra: dist/new.js");
  expect(failure).toContain("changed: server/dist/entry.js");
});

it("limits listed examples to five paths per category", async () => {
  const f = await fixture();

  for (let index = 0; index < 8; index += 1)
    await writeFile(join(f.root, "dist", `late-${index}.js`), "late\n");
  const withLate = await createRuntimeIdentity(f.root, f.identity);

  for (let index = 0; index < 8; index += 1)
    await rm(join(f.root, "dist", `late-${index}.js`));

  const failure = await verifyRuntimeIdentity(f.root, withLate).then(
    () => null,
    (error: Error) => error.message,
  );

  expect(failure).toContain("missing 8, extra 0, changed 0");
  expect(failure).toContain(
    "missing: dist/late-0.js, dist/late-1.js, dist/late-2.js, dist/late-3.js, dist/late-4.js, ...",
  );
  expect(failure).not.toContain("late-5");
});
