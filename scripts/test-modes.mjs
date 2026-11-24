#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const started = performance.now();

const [mode, ...args] = process.argv.slice(2);

const budget = mode === "full" ? 180_000 : 15_000;

const usage = `Development: pnpm test --package @omnyo/app -- src/path/example.test.tsx
             pnpm test:dev --package @omnyo/server -- test/example.test.ts -t "behavior"
Major release: pnpm test:full
Development requires existing test files in one package. It never runs the full suite.
Deadlines: development tests 15s; preparation commands 60s; full 180s. A timeout fails with incomplete coverage.
Optional --report-file PATH saves an exclusive execution receipt containing the Vitest result.
Optional --workspace PATH verifies an isolated source checkout with this runner.
Development checks stable Turbo prerequisites, then always executes the selected test fresh.
Optional --force forces full-mode execution; development accepts it for compatibility.`;

let activeChild;

function signalTree(child, signal) {
  if (!child?.pid) return;

  try {
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          stdio: "ignore",
        },
      );

      killer.on("error", () => {});
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopTree(child) {
  signalTree(child, "SIGTERM");
  await new Promise((done) => setTimeout(done, 250));
  signalTree(child, "SIGKILL");
}

function invocation(commandArgs) {
  const usesTurbo = commandArgs[0] === "exec" && commandArgs[1] === "turbo";

  return usesTurbo
    ? [
        process.execPath,
        resolve(root, "node_modules/turbo/bin/turbo"),
        ...commandArgs.slice(2),
      ]
    : ["pnpm", ...commandArgs];
}

async function run(
  commandArgs,
  capture = false,
  showFailure = false,
  timeoutMs,
) {
  const remaining = timeoutMs ?? budget - (performance.now() - started);

  if (remaining <= 1000)
    throw new Error("Deadline exceeded; coverage is incomplete.");
  const [executable, ...argv] = invocation(commandArgs);

  const child = spawn(executable, argv, {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  activeChild = child;
  let stdout = "";
  let timedOut = false;
  let stopping;

  if (capture)
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });

  const timeout = setTimeout(() => {
    timedOut = true;
    stopping = stopTree(child);
    stopping.catch(() => {});
  }, remaining - 1000);

  try {
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) =>
        done(exitCode ?? (signal ? 1 : 0)),
      );
    });

    if (stopping) await stopping;

    if (timedOut) {
      if (capture) process.stdout.write(stdout);

      const error = new Error(
        "Deadline exceeded; owned test processes terminated; coverage is incomplete.",
      );

      error.timedOut = true;
      error.stdout = stdout;
      throw error;
    }

    if (code !== 0) {
      if (showFailure) process.stdout.write(stdout);
      const error = new Error(`pnpm exited ${code}; tests did not pass.`);
      error.stdout = stdout;
      throw error;
    }

    return stdout;
  } finally {
    clearTimeout(timeout);
    activeChild = undefined;
  }
}

async function selectedFile(input, pkgRoot) {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(input)) {
    throw new Error(
      `Select an existing test file, not a directory or pattern: ${input}`,
    );
  }

  const candidates = [
    ...new Set([resolve(pkgRoot, input), resolve(root, input)]),
  ];

  const matches = [];

  for (const candidate of candidates) {
    try {
      const actual = await realpath(candidate);

      if (!(await stat(actual)).isFile()) continue;
      const local = relative(pkgRoot, actual);

      if (
        !local ||
        local === ".." ||
        local.startsWith(`..${sep}`) ||
        isAbsolute(local)
      )
        continue;

      if (!matches.includes(actual)) matches.push(actual);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `Test file is missing, outside the selected package, or ambiguous: ${input}`,
    );
  }

  return relative(pkgRoot, matches[0]).split(sep).join("/");
}

async function main() {
  const { values, positionals } = parseArgs({
    args: args.filter((argument) => argument !== "--"),
    allowPositionals: true,
    options: {
      package: { type: "string" },
      workspace: { type: "string" },
      testNamePattern: { type: "string", short: "t" },
      "report-file": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(usage);

    return;
  }

  if (!["dev", "full"].includes(mode)) throw new Error(usage);

  if (values.workspace) root = await realpath(resolve(values.workspace));

  if (mode === "dev" && (!values.package || positionals.length === 0))
    throw new Error(usage);

  if (
    mode === "full" &&
    (values.package || values.testNamePattern || positionals.length)
  ) {
    throw new Error(
      "Full mode accepts no selection: it runs all workspace test tasks.",
    );
  }

  const graph =
    mode === "dev"
      ? JSON.parse(
          await run(
            [
              "exec",
              "turbo",
              "run",
              "test",
              `--filter=${values.package}`,
              "--dry=json",
            ],
            true,
            true,
            60_000,
          ),
        )
      : null;

  const selectedTask = graph?.tasks?.find(
    (task) => task.taskId === values.package + "#test",
  );

  if (mode === "dev" && typeof selectedTask?.directory !== "string")
    throw new Error(`No workspace test task for package ${values.package}.`);

  const selectedRoot =
    mode === "dev"
      ? await realpath(resolve(root, selectedTask.directory))
      : null;

  if (
    selectedRoot &&
    (selectedRoot === root ||
      relative(root, selectedRoot).startsWith("..") ||
      isAbsolute(relative(root, selectedRoot)))
  )
    throw new Error("The selected package must belong to this workspace.");

  const packages =
    mode === "dev"
      ? [{ name: values.package, path: selectedRoot }]
      : JSON.parse(await run(["-r", "list", "--depth=-1", "--json"], true));

  const testPackages = [];

  for (const pkg of packages) {
    if (pkg.path === root) continue;

    const manifest = JSON.parse(
      await readFile(resolve(pkg.path, "package.json"), "utf8"),
    );

    if (
      manifest.scripts?.test &&
      (mode === "full" || manifest.name === pkg.name)
    )
      testPackages.push(pkg);
  }

  const command = ["exec", "turbo", "run", "test"];
  let selection;
  let selectedPackage;

  if (mode === "dev") {
    const pkg = testPackages.find((entry) => entry.name === values.package);

    if (!pkg)
      throw new Error(`No workspace test task for package ${values.package}.`);
    const pkgRoot = await realpath(pkg.path);
    selectedPackage = pkg;

    const files = [
      ...new Set(
        await Promise.all(
          positionals.map((file) => selectedFile(file, pkgRoot)),
        ),
      ),
    ];

    selection = {
      package: pkg.name,
      files,
      testNamePattern: values.testNamePattern ?? null,
    };
    command.push(
      `--filter=${pkg.name}`,
      "--concurrency=1",
      "--log-prefix=none",
      "--",
      ...files,
      "--maxWorkers=2",
      "--passWithNoTests=false",
      "--reporter=default",
      "--reporter=json",
    );

    if (values.testNamePattern)
      command.push("--testNamePattern", values.testNamePattern);
  } else {
    const concurrency = Math.min(2, availableParallelism());

    const workers = Math.max(
      1,
      Math.min(7, Math.floor(availableParallelism() / concurrency)),
    );

    selection = {
      packages: testPackages.map((pkg) => pkg.name).sort(),
      concurrency,
      workersPerPackage: workers,
    };
    command.push(
      `--concurrency=${concurrency}`,
      "--",
      `--maxWorkers=${workers}`,
    );
  }

  let reportHandle;

  const reportPath = values["report-file"]
    ? resolve(values["report-file"])
    : null;

  if (reportPath) reportHandle = await open(reportPath, "wx", 0o600);

  if (mode === "dev") command.splice(4, 0, "--only", "--force");
  else if (values.force) command.splice(4, 0, "--force");

  const vitestOutputPath = reportPath
    ? reportPath + ".vitest.json"
    : ".turbo/test-modes/vitest.json";

  const vitestPath =
    mode === "dev" ? resolve(selectedPackage.path, vitestOutputPath) : null;

  let reportLock;
  const lockPath = vitestPath ? vitestPath + ".lock" : null;

  if (vitestPath) command.push("--outputFile.json=" + vitestOutputPath);

  if (reportPath && mode === "full") {
    command.splice(4, 0, "--summarize", "--log-prefix=none");
    command.push(
      "--reporter=json",
      "--outputFile.json=.vitest-report/vitest.json",
    );
  }

  console.log(
    JSON.stringify({
      mode,
      selection,
      deadlineMs: budget,
      command: invocation(command),
    }),
  );

  const result = {
    schema: 1,
    mode,
    selection,
    deadlineMs: budget,
    command: invocation(command),
    status: "failed",
    executedTests: 0,
    reports: [],
  };

  let executionStartedAt = null;

  try {
    let output;
    let failure;
    let executionStarted = false;

    try {
      if (mode === "dev") {
        const task = graph.tasks?.find(
          (task) => task.taskId === selectedPackage.name + "#test",
        );

        const dependencies = task?.dependencies;

        if (
          !Array.isArray(dependencies) ||
          dependencies.some(
            (id) =>
              !/^(?:(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+|\/\/)#[a-zA-Z0-9_:.-]+$/.test(
                id,
              ) || !graph.tasks.some((task) => task.taskId === id),
          )
        )
          throw new Error("Invalid Turbo prerequisite graph.");

        const prerequisiteCommand = [
          "exec",
          "turbo",
          "run",
          ...dependencies,
          "--concurrency=1",
          "--log-prefix=none",
        ];

        result.prerequisites = {
          taskIds: dependencies,
          command: invocation(prerequisiteCommand),
          completed: false,
        };

        await mkdir(dirname(vitestPath), { recursive: true });

        try {
          reportLock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;

          throw new Error(
            "The test report is already locked. Use --report-file PATH for a separate run.",
            { cause: error },
          );
        }

        if (dependencies.length)
          await run(prerequisiteCommand, true, true, 60_000);

        result.prerequisites.completed = true;
        await rm(vitestPath, { force: true });
      }

      executionStarted = true;

      if (mode === "dev") executionStartedAt = performance.now();
      output = await run(
        command,
        mode === "dev",
        mode === "dev",
        mode === "dev" ? budget : undefined,
      );
    } catch (error) {
      output = error.stdout ?? "";
      failure = error;
    }

    if (!executionStarted) throw failure;

    let fileReport;

    if (vitestPath) {
      try {
        fileReport = JSON.parse(await readFile(vitestPath, "utf8"));
      } catch (error) {
        if (failure) throw failure;
        throw error;
      }
    }

    const fullReports = [];

    if (reportPath && mode === "full")
      for (const pkg of testPackages) {
        const value = await readFile(
          resolve(pkg.path, ".vitest-report/vitest.json"),
          "utf8",
        ).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });

        if (value) fullReports.push({ pkg, value: JSON.parse(value) });
      }

    const values = fileReport
      ? [fileReport]
      : mode === "full" && reportPath
        ? fullReports.map((report) => report.value)
        : output.split("\n").flatMap((line) => {
            try {
              const value = JSON.parse(line);

              return typeof value.numPassedTests === "number" &&
                typeof value.numFailedTests === "number"
                ? [value]
                : [];
            } catch {
              return [];
            }
          });

    result.reports = values.map((value, index) => {
      const pkg = selectedPackage ?? fullReports[index]?.pkg;

      return {
        name: pkg?.name ?? null,
        root: pkg ? relative(root, pkg.path).split(sep).join("/") : null,
        value,
      };
    });
    result.executedTests = values.reduce(
      (count, report) => count + report.numPassedTests + report.numFailedTests,
      0,
    );

    if (failure) throw failure;

    if (mode === "dev" && result.executedTests === 0) {
      throw new Error(
        "No tests executed; skipped or empty selections do not pass.",
      );
    }

    result.status = "passed";
  } catch (error) {
    result.reason = error.timedOut ? "timeout" : "execution-incomplete";
    throw error;
  } finally {
    result.elapsedMs = Math.round(
      performance.now() - (executionStartedAt ?? started),
    );

    if (executionStartedAt !== null)
      result.preparationMs = Math.round(executionStartedAt - started);

    if (reportLock) {
      await reportLock.close();

      if (executionStartedAt !== null) await rm(vitestPath, { force: true });

      await rm(lockPath);
    }

    if (reportHandle) {
      try {
        await reportHandle.writeFile(JSON.stringify(result) + "\n");
      } finally {
        await reportHandle.close();
      }
    }
  }

  console.log(
    JSON.stringify({
      mode,
      status: "passed",
      executedTests: result.executedTests,
      elapsedMs: result.elapsedMs,
      ...(result.preparationMs !== undefined
        ? { preparationMs: result.preparationMs }
        : {}),
    }),
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stopTree(activeChild).finally(() =>
      process.exit(signal === "SIGINT" ? 130 : 143),
    );
  });
}

main().catch((error) => {
  console.error(`Test mode failed: ${error.message}`);
  console.error(
    JSON.stringify({
      mode,
      status: "failed",
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
  process.exitCode = 1;
});
