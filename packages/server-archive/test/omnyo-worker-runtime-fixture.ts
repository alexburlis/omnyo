import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkerRuntimeIdentity } from "../src/runtime-identity.js";

export async function createOmnyoWorkerRuntimeFixture(
  runtimeRoot: string,
  labels = {
    runtimeVersion: "0.46.244+private.1",
    hostDaemonProtocolVersion: 253,
  },
) {
  const bin = {
    omnyo: "dist/omnyo.js",
    "omnyo-app": "dist/omnyo-app.js",
    "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
  };

  for (const directory of ["dist/plugin-sdk", "host-daemon/dist"])
    await mkdir(join(runtimeRoot, directory), { recursive: true });

  for (const path of [
    ...Object.values(bin),
    "dist/machine-state.mjs",
    "host-daemon/dist/daemon-bundle.mjs",
  ])
    await writeFile(join(runtimeRoot, path), "export const bound=true;\n");
  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({
      name: "omnyo-app",
      version: labels.runtimeVersion,
      files: ["dist", "host-daemon", "README.md"],
      bin,
    }),
  );
  const archive = Buffer.from("fixture private SDK archive");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const file = `omnyo-plugin-sdk-0.6.44-${sha256.slice(0, 12)}.tgz`;
  await writeFile(join(runtimeRoot, "dist/plugin-sdk", file), archive);
  await writeFile(
    join(runtimeRoot, "dist/plugin-sdk/manifest.json"),
    JSON.stringify({
      schema: 1,
      packageName: "@omnyo/plugin-sdk",
      version: "0.6.44",
      file,
      sha256,
    }),
  );
  const identity = await createWorkerRuntimeIdentity(runtimeRoot, labels);
  await writeFile(
    join(runtimeRoot, "dist/runtime-identity.json"),
    JSON.stringify(identity),
  );

  return identity;
}
