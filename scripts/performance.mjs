import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPrepared,
  bindingSchema,
  compare,
  digest,
  failures,
  markdown,
  scorecardSchema,
} from "../apps/server/test/performance/scorecard.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const args = process.argv.slice(2);

const command = args.shift();

const options = new Map();

while (args.length) {
  const flag = args.shift();
  const value = args.shift();

  if (!flag?.startsWith("--") || !value || options.has(flag))
    throw new Error("Expected unique --option value pairs");
  options.set(flag, value);
}

const supported = {
  prepare: [],
  run: [
    "--output",
    "--playwright",
    "--samples",
    "--baseline",
    "--relative",
    "--absolute-ms",
    "--diagnostic",
  ],
  compare: ["--baseline", "--candidate", "--relative", "--absolute-ms"],
  report: ["--candidate"],
};

if (!Object.hasOwn(supported, command))
  throw new Error(
    "Usage: node --import tsx scripts/performance.mjs prepare|run|compare|report [--option value]. See docs/performance-scorecard.md",
  );

for (const flag of options.keys())
  if (!supported[command].includes(flag))
    throw new Error(`Unknown ${command} option: ${flag}`);

const required = (flag) => {
  const value = options.get(flag);

  if (!value) throw new Error(`Required: ${flag}`);

  return resolve(value);
};

const execute = (cmd, argv, extra = {}) => {
  const result = spawnSync(cmd, argv, {
    cwd: root,
    stdio: "inherit",
    ...extra,
  });

  if (result.error) throw result.error;

  return result.status ?? 1;
};

const git = (...argv) => {
  const result = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) throw new Error("Could not bind git source");

  return result.stdout;
};

async function hashFiles(directory) {
  const hash = createHash("sha256");

  const visit = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(path, entry.name);

      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name !== "performance-binding.json") {
        hash.update(relative(directory, file));
        hash.update("\0");
        hash.update(await readFile(file));
      } else if (!entry.isFile())
        throw new Error("Build/source hash refuses symlink entries");
    }
  };

  await visit(directory);

  return hash.digest("hex");
}

async function binding() {
  const sourceFiles = git(
    "ls-files",
    "-z",
    "apps",
    "packages",
    "plugins",
    "tests",
    "scripts",
    "pnpm-lock.yaml",
    "turbo.json",
    "package.json",
  )
    .split("\0")
    .filter(Boolean);

  const hash = createHash("sha256");

  const untracked = git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "apps",
    "packages",
    "plugins",
    "tests",
    "scripts",
  )
    .split("\0")
    .filter(Boolean);

  for (const file of [...new Set([...sourceFiles, ...untracked])].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(
      await readFile(resolve(root, file)).catch((error) => {
        if (error.code === "ENOENT") return "<deleted>";
        throw error;
      }),
    );
  }

  const suiteFiles = [
    "scripts/performance.mjs",
    "apps/server/test/performance/app-performance.ts",
    "apps/server/test/performance/scorecard.ts",
    "apps/server/test/performance/checkpoint.ts",
    "apps/server/test/performance/frontend-loading.test.ts",
    "apps/server/test/helpers/test-app.ts",
    "apps/server/test/helpers/seed.ts",
    "apps/server/test/helpers/provider-registry.ts",
    "apps/server/test/helpers/available-models.ts",
    "apps/server/test/setup/warm-test-harness.ts",
    "apps/server/vitest.config.ts",
    "vitest.shared.ts",
  ];

  const suiteHash = digest(
    (
      await Promise.all(
        suiteFiles.map((file) => readFile(resolve(root, file), "utf8")),
      )
    ).join("\0"),
  );

  return {
    source: {
      commit: git("rev-parse", "HEAD").trim(),
      treeHash: hash.digest("hex"),
      dirty:
        git("status", "--porcelain", "--untracked-files=normal").trim().length >
        0,
    },
    buildHash: digest(
      `${await hashFiles(resolve(root, "apps/app/dist"))}:${await hashFiles(resolve(root, "plugins/thread-list/.bundled-runtime"))}`,
    ),
    suiteHash,
  };
}

const parse = async (path) =>
  scorecardSchema.parse(JSON.parse(await readFile(path, "utf8")));

const compareReports = async (baseline, candidate) => {
  const issues = compare(
    await parse(baseline),
    await parse(candidate),
    Number(options.get("--relative") ?? "0.3"),
    Number(options.get("--absolute-ms") ?? "20"),
  );

  if (issues.length) {
    process.stderr.write(issues.join("\n") + "\n");
    process.exitCode = 1;
  } else
    process.stdout.write(
      "Comparable results passed the configured regression tolerances.\n",
    );
};

if (command === "prepare") {
  const status = execute("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@omnyo/app",
    "--output-logs=errors-only",
  ]);

  const pluginStatus =
    status ||
    execute("pnpm", [
      "exec",
      "turbo",
      "run",
      "prepare:bundled",
      "--filter=omnyo-plugin-thread-list",
      "--output-logs=errors-only",
    ]);

  const testStatus = pluginStatus
    ? pluginStatus
    : execute("pnpm", [
        "exec",
        "turbo",
        "run",
        "test",
        "--filter=@omnyo/server",
        "--output-logs=errors-only",
        "--",
        "test/performance/scorecard.test.ts",
        "test/performance/checkpoint.test.ts",
      ]);

  if (testStatus) process.exitCode = testStatus;
  else {
    const prepared = await binding();
    await writeFile(
      resolve(root, "apps/app/dist/performance-binding.json"),
      JSON.stringify(prepared, null, 2) + "\n",
    );
    process.stdout.write(
      "Prepared app and source binding. Run measurements through Omnyo Resources --benchmark.\n",
    );
  }
} else if (command === "run") {
  const diagnostic = options.get("--diagnostic");

  if (
    diagnostic &&
    (!["history-navigation", "browser-actions"].includes(diagnostic) ||
      options.has("--baseline"))
  )
    throw new Error(
      "Diagnostic must be history-navigation or browser-actions and cannot compare/promote baselines",
    );
  const output = required("--output");
  const playwright = required("--playwright");

  if (!output.endsWith(".json")) throw new Error("Output must end in .json");
  const sampleCount = Number(options.get("--samples") ?? "30");

  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 100)
    throw new Error("Samples must be an integer from 1 to 100");
  const preparedPath = resolve(root, "apps/app/dist/performance-binding.json");

  const prepared = bindingSchema.parse(
    JSON.parse(await readFile(preparedPath, "utf8")),
  );

  const current = await binding();

  assertPrepared(prepared, current);
  await mkdir(resolve(output, ".."), { recursive: true });

  for (const path of [
    output,
    output.replace(/\.json$/u, ".md"),
    output.replace(/\.json$/u, ".progress.json"),
    output.replace(/\.json$/u, ".progress.json.pending"),
    output.replace(/\.json$/u, ".runner.json"),
  ]) {
    const exists = await lstat(path).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );

    if (exists)
      throw new Error(
        "Output already exists; choose a new result path. Baselines are never overwritten.",
      );
  }

  const runBinding = output.replace(/\.json$/u, ".binding.json");
  await writeFile(runBinding, JSON.stringify(current, null, 2) + "\n", {
    flag: "wx",
  });

  const status = execute(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "test",
      "--filter=@omnyo/server",
      "--only",
      "--output-logs=full",
      "--",
      "test/performance/frontend-loading.test.ts",
    ],
    {
      env: {
        ...process.env,
        OMNYO_FRONTEND_PLAYWRIGHT_MODULE: playwright,
        OMNYO_FRONTEND_MEASUREMENT_OUTPUT: output,
        OMNYO_FRONTEND_APP_DIST: resolve(root, "apps/app/dist"),
        OMNYO_PERFORMANCE_SUITE: "1",
        OMNYO_PERFORMANCE_BINDING: runBinding,
        OMNYO_PERFORMANCE_SAMPLES: String(sampleCount),
        OMNYO_PERFORMANCE_DIAGNOSTIC: diagnostic ?? "",
      },
    },
  );

  const after = await binding();

  if (
    current.source.treeHash !== after.source.treeHash ||
    current.buildHash !== after.buildHash
  ) {
    const invalid = await parse(output).catch(() => null);

    if (invalid) {
      invalid.errors.push(
        "Source or built app changed during measurement; this result is invalid for baselines",
      );
      await writeFile(output, JSON.stringify(invalid, null, 2) + "\n");
      await writeFile(output.replace(/\.json$/u, ".md"), markdown(invalid));
    }

    process.stderr.write(
      "Source or built app changed during measurement; result cannot be used as a baseline.\n",
    );
    process.exitCode = 1;
  }

  if (status) process.exitCode = status;
  else if (diagnostic) {
    const report = JSON.parse(await readFile(output, "utf8"));

    if (report.diagnostic !== diagnostic)
      throw new Error("Missing diagnostic result");
    process.stdout.write(
      `${diagnostic} diagnostic passed; this partial result cannot be a baseline.\n`,
    );
  } else {
    const report = await parse(output);
    const issues = failures(report);

    if (issues.length) process.exitCode = 1;
    process.stdout.write(markdown(report));

    if (options.has("--baseline"))
      await compareReports(required("--baseline"), output);
  }
} else if (command === "compare")
  await compareReports(required("--baseline"), required("--candidate"));
else process.stdout.write(markdown(await parse(required("--candidate"))));
