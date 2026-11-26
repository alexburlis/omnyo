import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function preparePublicRuntime({
  root,
  outputDirectory,
  identity,
}) {
  const packageRoot = resolve(root, "packages/omnyo-app");
  const verifierPath = join(packageRoot, "dist/runtime-identity-verifier.js");

  if (
    (await realpath(packageRoot)) !== packageRoot ||
    (await realpath(verifierPath)) !== verifierPath
  )
    throw new Error(
      "Runtime checkpoint requires fixed package and verifier paths",
    );

  const verifier = await import(pathToFileURL(verifierPath).href);

  const runtime = await verifier.verifyRuntimeIdentity(
    packageRoot,
    await verifier.readRuntimeIdentity(packageRoot),
  );

  const html = await readFile(join(packageRoot, "app/dist/index.html"), "utf8");

  const sourceMarkers = [
    ...html.matchAll(
      /<meta\s+name="omnyo-web-source"\s+content="([a-f0-9]{40})"\s*\/?\s*>/gu,
    ),
  ];

  if (
    !/^[a-f0-9]{40}$/u.test(identity.sourceCommit) ||
    sourceMarkers.length !== 1 ||
    sourceMarkers[0][1] !== identity.sourceCommit ||
    runtime.runtimeVersion !== identity.version ||
    runtime.hostDaemonProtocolVersion !== identity.protocolVersion
  )
    throw new Error("Runtime checkpoint differs from the selected release");

  const requireOutsidePackage = (path) => {
    const fromPackage = relative(packageRoot, path);

    if (
      fromPackage === "" ||
      (!isAbsolute(fromPackage) &&
        fromPackage !== ".." &&
        !fromPackage.startsWith("../"))
    )
      throw new Error("Runtime checkpoint output must be outside the package");
  };

  const requestedOutput = resolve(outputDirectory);
  requireOutsidePackage(requestedOutput);
  await mkdir(requestedOutput, { recursive: true, mode: 0o700 });
  const output = await realpath(requestedOutput);
  requireOutsidePackage(output);

  const snapshot = join(output, "runtime");
  await mkdir(snapshot, { mode: 0o700 });

  try {
    for (const path of ["dist", "server/dist", "host-daemon/dist", "app/dist"])
      await mkdir(join(snapshot, path), { recursive: true, mode: 0o700 });

    const paths = [
      ...runtime.files.map((file) => file.path),
      "dist/runtime-identity.json",
    ];

    for (let offset = 0; offset < paths.length; offset += 8) {
      const results = await Promise.allSettled(
        paths.slice(offset, offset + 8).map(async (path) => {
          const target = join(snapshot, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await copyFile(
            join(packageRoot, path),
            target,
            constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
          );
        }),
      );

      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }

    const copied = await verifier.readRuntimeIdentity(snapshot);

    if (JSON.stringify(copied) !== JSON.stringify(runtime))
      throw new Error("Runtime checkpoint identity changed during copying");

    await verifier.verifyRuntimeIdentity(snapshot, copied);

    const receipt = {
      schema: 1,
      sourceCommit: identity.sourceCommit,
      version: identity.version,
      protocolVersion: identity.protocolVersion,
      runtimeSha256: runtime.runtimeSha256,
      runtimePath: "runtime",
    };

    await writeFile(
      join(output, "runtime-prepared.json"),
      JSON.stringify(receipt) + "\n",
      { flag: "wx", mode: 0o600 },
    );

    return receipt;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}
