import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const keys = ["--checkout", "--data-root", "--project-root", "--host-id", "--name", "--output"];

const values = new Map();

const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  const value = args[index + 1];

  if (!keys.includes(key) || !value || values.has(key))
    throw new Error("SOURCE_FIXTURE_ARGUMENTS_INVALID");
  values.set(key, value);
}

const options = z
  .strictObject({
    checkout: z.string(),
    dataRoot: z.string(),
    projectRoot: z.string(),
    hostId: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    output: z.string(),
  })
  .parse({
    checkout: values.get("--checkout"),
    dataRoot: values.get("--data-root"),
    projectRoot: values.get("--project-root"),
    hostId: values.get("--host-id"),
    name: values.get("--name"),
    output: values.get("--output"),
  });

if (
  !process.versions.node.startsWith("22.") ||
  ![options.checkout, options.dataRoot, options.projectRoot, options.output].every(isAbsolute)
)
  throw new Error("EXPLICIT_NODE22_SOURCE_PATHS_REQUIRED");

await readFile(join(options.dataRoot, "verify-omnyo-owner"));

await lstat(options.output).then(
  () => {
    throw new Error("SOURCE_FIXTURE_OUTPUT_EXISTS");
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);

const projectRoot = await realpath(options.projectRoot);

const isGitRepo = await lstat(join(projectRoot, ".git")).then(
  () => true,
  (error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  },
);

const { createConnection, createProject, createEnvironment, createThread, noopNotifier } =
  await import(pathToFileURL(join(options.checkout, "packages/db/src/index.ts")).href);

const db = createConnection(join(options.dataRoot, "app.db"));

try {
  const fixture = db.transaction((tx) => {
    const { project } = createProject(tx, noopNotifier, {
      name: options.name,
      source: { type: "local_path", hostId: options.hostId, path: projectRoot },
    });

    const environment = createEnvironment(tx, noopNotifier, {
      name: options.name,
      projectId: project.id,
      hostId: options.hostId,
      path: projectRoot,
      isGitRepo,
      providerOwnsPath: false,
      status: "ready",
    });

    const thread = createThread(tx, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      title: options.name,
      status: "idle",
    });

    return {
      surface: "source-only synthetic fixture seed; no dispatch",
      projectRoot,
      projectId: project.id,
      environmentId: environment.id,
      hostId: options.hostId,
      threadId: thread.id,
      providerId: "codex",
      status: "idle",
      providerTurns: 0,
    };
  });

  await writeFile(options.output, JSON.stringify(fixture, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify(fixture) + "\n");
} finally {
  db.$client.close();
}
