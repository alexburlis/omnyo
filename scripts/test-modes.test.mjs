import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = dirname(fileURLToPath(import.meta.url));

async function fixture(t, outcome = "passed") {
  const root = await mkdtemp(join(tmpdir(), "omnyo-test-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "packages/example/test"), { recursive: true });
  await copyFile(
    join(source, "test-modes.mjs"),
    join(root, "scripts/test-modes.mjs"),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  await writeFile(
    join(root, "packages/example/package.json"),
    JSON.stringify({
      name: "@fixture/example",
      scripts: { test: "vitest run" },
    }),
  );
  await writeFile(
    join(root, "packages/example/test/contract.test.mjs"),
    "export {};\n",
  );
  const tool = join(root, "bin/pnpm");
  await writeFile(
    tool,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
if (args[0] === "-r") { if (${JSON.stringify(outcome)} === "discovery-unavailable") process.exit(1); console.log(JSON.stringify([{name:"fixture",path:root},{name:"@fixture/example",path:path.join(root,"packages/example")} ])); process.exit(0); }
fs.appendFileSync(path.join(root,"commands.jsonl"), JSON.stringify(args)+"\\n");
const outcome = ${JSON.stringify(outcome)};
if (args.includes("--dry=json")) { console.log(JSON.stringify({tasks:[{taskId:"@fixture/example#test",directory:"packages/example",dependencies:["@fixture/example#generate"]},{taskId:"@fixture/example#generate",dependencies:[]}]})); process.exit(0); }
if (args.includes("@fixture/example#generate")) { if(outcome === "prerequisite-failed") process.exit(1); fs.writeFileSync(path.join(root,"prerequisites-complete"),"yes"); process.exit(0); }
if(args.includes("--only") && !fs.existsSync(path.join(root,"prerequisites-complete"))) process.exit(2);
fs.appendFileSync(path.join(root,"executions.jsonl"), JSON.stringify({report:args.find(a=>a.startsWith("--outputFile.json="))})+"\\n");
if (outcome === "termination-denied") {
  fs.writeFileSync(path.join(root,"test-child.pid"), String(process.pid));
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(0), 1500);
} else {
const status = outcome === "failed" ? "failed" : "passed";
const report = {success: status === "passed",numPassedTests:["passed","discovery-unavailable"].includes(outcome) ? 2 : 0,numFailedTests:status === "failed" ? 1 : 0,testResults:[{name:path.join(root,"packages/example/test/contract.test.mjs"),status,assertionResults:outcome === "empty" ? [] : Array.from({length:outcome === "passed"?2:1},(_,index)=>({fullName:"public behavior "+index,status,failureMessages:status === "failed" ? ["real failure"] : []}))}]};
const output = args.find(a=>a.startsWith("--outputFile.json="));
if(output){const target=output.split("=").slice(1).join("=");const actual=path.isAbsolute(target)?target:path.join(root,"packages/example",target);fs.mkdirSync(path.dirname(actual),{recursive:true});fs.writeFileSync(actual,JSON.stringify(report));} else console.log(JSON.stringify(report));
if (outcome === "failed" && args.includes("--reporter=default")) console.error("public behavior 0: real failure");
process.exit(status === "failed" ? 1 : 0);
}
`,
  );
  await chmod(tool, 0o755);
  await mkdir(join(root, "node_modules/turbo/bin"), { recursive: true });
  await writeFile(
    join(root, "node_modules/turbo/bin/turbo"),
    (await readFile(tool, "utf8")).replace(
      "const args = process.argv.slice(2);",
      'const args = ["exec", "turbo", ...process.argv.slice(2)];',
    ),
  );

  return {
    root,
    report: join(root, "result.json"),
    async run(
      extra = [],
      files = ["test/contract.test.mjs"],
      mode = "dev",
      nodeArgs = [],
    ) {
      const child = spawn(
        process.execPath,
        [
          ...nodeArgs,
          join(root, "scripts/test-modes.mjs"),
          mode,
          ...(mode === "dev"
            ? ["--package", "@fixture/example", ...extra, "--", ...files]
            : extra),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: join(root, "bin") + ":" + process.env.PATH,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));

      const code = await new Promise((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });

      return { code, output };
    },
  };
}

test("development keeps its test deadline after prerequisites finish", async (t) => {
  const f = await fixture(t);
  const preload = join(f.root, "preparation-clock.mjs");
  await writeFile(
    preload,
    `import { existsSync } from "node:fs";
const now = performance.now.bind(performance);
performance.now = () => now() + (existsSync(${JSON.stringify(join(f.root, "prerequisites-complete"))}) ? 15000 : 0);
`,
  );

  const result = await f.run(
    ["--report-file", f.report],
    ["test/contract.test.mjs"],
    "dev",
    ["--import", preload],
  );

  assert.equal(result.code, 0, result.output);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.prerequisites.completed, true);
  assert.equal(report.executedTests, 2);
  assert.equal(report.deadlineMs, 15000);
  assert.ok(report.elapsedMs <= report.deadlineMs);
  assert.ok(report.preparationMs >= 15000);
});

test("a termination error preserves the failed execution receipt", async (t) => {
  const f = await fixture(t, "termination-denied");
  const preload = join(f.root, "termination-error.mjs");
  await writeFile(
    preload,
    `import { existsSync } from "node:fs";
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay > 1000 && existsSync(${JSON.stringify(join(f.root, "prerequisites-complete"))}) ? 500 : delay, ...args);
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === "SIGKILL") throw Object.assign(new Error("fixture termination denied"), { code: "EPERM" });
  return kill(pid, signal);
};
`,
  );

  const run = await f.run(["--report-file", f.report], undefined, "dev", [
    "--import",
    preload,
  ]);

  assert.equal(run.code, 1);
  const pid = Number(await readFile(join(f.root, "test-child.pid"), "utf8"));
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((done) => setTimeout(done, 25));
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      break;
    }
  }

  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.executedTests, 0);
  assert.equal(report.reason, "execution-incomplete");
  assert.equal(report.prerequisites.completed, true);
  assert.match(run.output, /fixture termination denied/u);
});

for (const outcome of ["passed", "failed", "empty"]) {
  test(`selective report preserves actual ${outcome} execution`, async (t) => {
    const f = await fixture(t, outcome);
    const run = await f.run(["--report-file", f.report]);
    assert.equal(run.code, outcome === "passed" ? 0 : 1, run.output);
    const report = JSON.parse(await readFile(f.report, "utf8"));
    assert.equal(report.status, outcome === "passed" ? "passed" : "failed");
    assert.equal(
      report.executedTests,
      outcome === "passed" ? 2 : outcome === "failed" ? 1 : 0,
    );
    assert.equal(report.reports[0].name, "@fixture/example");
    assert.equal(report.deadlineMs, 15000);
    assert.deepEqual(report.selection.files, ["test/contract.test.mjs"]);
  });
}

test("selective report refuses missing files and protects an existing receipt", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.run(["--report-file", f.report], ["test/missing.test.mjs"])).code,
    1,
  );
  await writeFile(f.report, "retained");
  assert.equal((await f.run(["--report-file", f.report])).code, 1);
  assert.equal(await readFile(f.report, "utf8"), "retained");
  await assert.rejects(readFile(join(f.root, "executions.jsonl")), {
    code: "ENOENT",
  });
});

test("a selected package executes without enumerating unrelated workspaces", async (t) => {
  const f = await fixture(t, "discovery-unavailable");
  const run = await f.run(["--report-file", f.report]);
  assert.equal(run.code, 0, run.output);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.executedTests, 2);
  assert.equal(report.prerequisites.completed, true);
});

test("the operator runner executes the selected checkout instead of its own workspace", async (t) => {
  const operator = await fixture(t, "failed");
  const target = await fixture(t);

  const run = await operator.run([
    "--workspace",
    target.root,
    "--report-file",
    operator.report,
  ]);

  assert.equal(run.code, 0, run.output);
  assert.equal(
    JSON.parse(await readFile(operator.report, "utf8")).executedTests,
    2,
  );
  await assert.rejects(readFile(join(operator.root, "executions.jsonl")), {
    code: "ENOENT",
  });
  assert.ok(
    (await readFile(join(target.root, "executions.jsonl"), "utf8")).length > 0,
  );
});

test("refuses a locked default report before preparing dependencies", async (t) => {
  const f = await fixture(t);
  const shared = join(f.root, "packages/example/.turbo/test-modes");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "vitest.json.lock"), "another run");
  await writeFile(join(shared, "vitest.json"), "retained report");

  const result = await f.run();

  const commands = (await readFile(join(f.root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.code, 1);
  assert.match(result.output, /already locked/u);
  assert.ok(
    !commands.some((args) => args.includes("@fixture/example#generate")),
  );
  assert.equal(
    await readFile(join(shared, "vitest.json"), "utf8"),
    "retained report",
  );
});

test("prints failed assertions without requiring a report file", async (t) => {
  const f = await fixture(t, "failed");
  const result = await f.run();

  assert.equal(result.code, 1);
  assert.match(result.output, /public behavior 0: real failure/u);
});

test("an explicit report isolates Vitest output from another run's lock", async (t) => {
  const f = await fixture(t);
  const shared = join(f.root, "packages/example/.turbo/test-modes");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "vitest.json.lock"), "another run");
  await writeFile(join(shared, "vitest.json"), "retained report");

  const result = await f.run(["--report-file", f.report]);

  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(await readFile(f.report, "utf8")).executedTests, 2);
  assert.equal(
    await readFile(join(shared, "vitest.json.lock"), "utf8"),
    "another run",
  );
  assert.equal(
    await readFile(join(shared, "vitest.json"), "utf8"),
    "retained report",
  );
});

test("selective force retains the original bounded runner and Turbo prerequisites", async (t) => {
  const f = await fixture(t);
  const run = await f.run(["--report-file", f.report, "--force"]);
  assert.equal(run.code, 0, run.output);

  const command = (await readFile(join(f.root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((args) => args.includes("--only"));

  assert.ok(command.includes("--force"));
  assert.ok(command.includes("--filter=@fixture/example"));
  assert.ok(command.includes("--only"));
});

test("explicit major mode retains the full workspace and 180-second deadline", async (t) => {
  const f = await fixture(t);
  const run = await f.run(["--report-file", f.report], [], "full");
  assert.equal(run.code, 0, run.output);
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.mode, "full");
  assert.equal(report.deadlineMs, 180000);
  assert.equal(report.executedTests, 2);

  const command = JSON.parse(
    (await readFile(join(f.root, "commands.jsonl"), "utf8")).trim(),
  );

  assert.ok(command.includes("--summarize"));
  assert.ok(!command.some((argument) => argument.startsWith("--filter=")));
  assert.ok(command.includes("--outputFile.json=.vitest-report/vitest.json"));
});

test("different receipts retain stable checked prerequisites and execute both selections", async (t) => {
  const f = await fixture(t);
  const second = join(f.root, "second.json");

  for (const report of [f.report, second]) {
    const result = await f.run(["--report-file", report]);
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(await readFile(report, "utf8")).executedTests, 2);
  }

  const commands = (await readFile(join(f.root, "commands.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const prerequisites = commands.filter((args) =>
    args.includes("@fixture/example#generate"),
  );

  assert.equal(prerequisites.length, 2);
  assert.deepEqual(prerequisites[0], prerequisites[1]);
  assert.ok(!prerequisites[0].includes("--force"));

  const executions = (await readFile(join(f.root, "executions.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(executions.length, 2);
  assert.notEqual(executions[0].report, executions[1].report);
  assert.equal(
    executions[0].report,
    `--outputFile.json=${f.report}.vitest.json`,
  );
  assert.equal(executions[1].report, `--outputFile.json=${second}.vitest.json`);
});

test("failed prerequisite refuses actual selected test execution", async (t) => {
  const f = await fixture(t, "prerequisite-failed");
  const stale = join(f.root, "packages/example/.turbo/test-modes");
  await mkdir(stale, { recursive: true });
  await writeFile(
    join(stale, "vitest.json"),
    JSON.stringify({ numPassedTests: 9, numFailedTests: 0, testResults: [] }),
  );
  const result = await f.run(["--report-file", f.report]);
  assert.equal(result.code, 1, result.output);
  await assert.rejects(readFile(join(f.root, "executions.jsonl")), {
    code: "ENOENT",
  });
  const report = JSON.parse(await readFile(f.report, "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.executedTests, 0);
});
