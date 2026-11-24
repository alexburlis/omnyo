import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    "pack-destination": { type: "string" },
  },
});

if (!values.package || !values["pack-destination"]) {
  throw new Error("Expected --package and --pack-destination");
}

const packageRoot = resolve(values.package);

const destination = resolve(values["pack-destination"]);

const listed = await execute(
  "npm",
  ["pack", packageRoot, "--dry-run", "--json"],
  { maxBuffer: 10_000_000 },
);

process.stderr.write(listed.stderr);

const [packed] = z
  .array(
    z.object({
      files: z
        .array(
          z.object({
            path: z
              .string()
              .min(1)
              .refine(
                (value) =>
                  !isAbsolute(value) &&
                  !value.includes("\\") &&
                  !value.includes("\0") &&
                  !value
                    .split("/")
                    .some(
                      (part) => part === "" || part === "." || part === "..",
                    ),
                "Invalid runtime package inventory path",
              ),
          }),
        )
        .min(1),
    }),
  )
  .length(1)
  .parse(JSON.parse(listed.stdout));

const stage = join(tmpdir(), `omnyo-runtime-pack-${randomUUID()}`);

process.stderr.write(
  JSON.stringify({
    event: "runtime-package-stage",
    stage,
    disposition: "disposable after npm pack exits",
  }) + "\n",
);

await mkdir(stage);

try {
  for (const file of packed.files) {
    const target = join(stage, file.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(
      join(packageRoot, file.path),
      target,
      constants.COPYFILE_FICLONE,
    );
  }

  const { readRuntimeIdentity, createRuntimeIdentity } = await import(
    pathToFileURL(join(stage, "dist/runtime-identity-verifier.js")).href
  );

  const originalIdentity = await readRuntimeIdentity(stage);
  const manifestPath = join(stage, "package.json");

  const manifest = z
    .looseObject({
      name: z.literal("omnyo-app"),
      version: z.string().min(1),
      devDependencies: z.record(z.string(), z.string()).optional(),
    })
    .parse(JSON.parse(await readFile(manifestPath, "utf8")));

  delete manifest.devDependencies;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const identity = await createRuntimeIdentity(stage, {
    runtimeVersion: originalIdentity.runtimeVersion,
    hostDaemonProtocolVersion: originalIdentity.hostDaemonProtocolVersion,
  });

  await writeFile(
    join(stage, "dist/runtime-identity.json"),
    JSON.stringify(identity) + "\n",
  );

  const { stdout, stderr } = await execute(
    "npm",
    [
      "pack",
      stage,
      "--pack-destination",
      destination,
      "--ignore-scripts",
      "--json",
    ],
    { maxBuffer: 10_000_000 },
  );

  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(stage, { recursive: true, force: true });
}
