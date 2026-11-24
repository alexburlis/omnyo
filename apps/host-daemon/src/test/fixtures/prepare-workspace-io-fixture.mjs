import { mkdir, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleTargets } from "../../../scripts/bundle-manifest.mjs";
import { buildNodeEsmEntry } from "../../../../../scripts/build-utils.mjs";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

const packageRoot = path.resolve(fixtureDirectory, "../../..");

const repository = path.resolve(packageRoot, "../..");

const neededWorkers = new Set([
  "workspace observer child",
  "workspace read child",
  "provider bridge worker",
  "plugin host worker",
  "file search worker",
  "process launcher worker",
  "parcel watcher child",
]);

export async function prepareWorkspaceIoFixture(directory) {
  const nodeModules = path.join(directory, "node_modules");
  const hostDependencies = path.join(packageRoot, "node_modules");
  await mkdir(nodeModules);

  for (const name of await readdir(hostDependencies)) {
    if (name !== "fs-native-extensions")
      await symlink(
        path.join(hostDependencies, name),
        path.join(nodeModules, name),
      );
  }

  await symlink(
    path.join(repository, "packages/config/node_modules/fs-native-extensions"),
    path.join(nodeModules, "fs-native-extensions"),
  );
  const fixture = path.join(directory, "fixture.mjs");

  const targets = [
    ...bundleTargets
      .filter((target) => neededWorkers.has(target.label))
      .map((target) => ({
        entryPoint: target.entryPoint,
        outfile: path.join(directory, path.basename(target.outfile)),
      })),
    {
      entryPoint: path.join(
        fixtureDirectory,
        "workspace-io-isolation-child.ts",
      ),
      outfile: fixture,
    },
    {
      entryPoint: path.join(
        repository,
        "tests/scripted-echo-provider/src/provider-bridge.ts",
      ),
      outfile: path.join(directory, "scripted-echo-provider.mjs"),
    },
  ];

  const results = await Promise.allSettled(
    targets.map((target) =>
      buildNodeEsmEntry({
        cleanDist: false,
        packageRoot,
        sourcemap: false,
        ...target,
      }),
    ),
  );

  const failed = results.find((result) => result.status === "rejected");

  if (failed) throw failed.reason;

  return fixture;
}
