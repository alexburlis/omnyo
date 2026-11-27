import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const [
  packageRoot,
  projectRoot,
  sourceCli,
  threadId,
  ownerPath,
  evidencePath,
  port = "58785",
  scenario = "before-save",
  explicitDataRoot = "",
  sourceUrl = "",
] = process.argv.slice(2);

if (!evidencePath)
  throw new Error("Explicit package/project/source CLI/thread/owner/evidence paths are required.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const env = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  USER: process.env.USER,
  LANG: "en_US.UTF-8",
};

async function cli(args, input = "") {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [sourceCli, ...args], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = [];
    const errors = [];
    let bytes = 0;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("SOURCE_CLI_STAGE_TIMEOUT"));
    }, 14000);

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;

      if (bytes > 1048576) child.kill("SIGTERM");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);

      try {
        const value = JSON.parse(Buffer.concat(out).toString());

        if ([0, 1, 2, 130].includes(code)) accept(value);
        else reject(new Error(`SOURCE_CLI_FAILED_${code}`));
      } catch {
        reject(new Error(`SOURCE_CLI_INVALID_${code}_${args[0]}_${args[1]}`));
      }
    });
    child.stdin.end(input);
  });
}

let fixture;

let cleanupFailure;

let proofFailure;

const start = performance.now();

const producer = spawn(
  process.execPath,
  [
    join(root, "tests/e2e/lifecycle-fixture.mjs"),
    packageRoot,
    projectRoot,
    ownerPath,
    port,
    scenario,
    explicitDataRoot,
  ],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);

const exited = new Promise((resolve) => producer.on("exit", (code) => resolve(code)));

try {
  fixture = await new Promise((accept, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("FIXTURE_STARTUP_TIMEOUT")), 5000);
    producer.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n")[0];

      try {
        const value = JSON.parse(line);

        if (value.ready) {
          clearTimeout(timer);
          accept(value);
        }
      } catch {}
    });
    producer.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("FIXTURE_STARTUP_FAILED"));
    });
  });
  await cli(["thread", "stop", threadId, "--json"]);
  const beforeEvents = await cli(["thread", "log", threadId, "--json", "--limit", "100"]);

  const historicalStops = beforeEvents.filter(
    (event) => event.type === "system/thread/interrupted" && event.data.reason === "manual-stop",
  );

  assert.ok(historicalStops.length > 0);

  const requirements = [
    {
      id: "stop-proof",
      text:
        scenario === "after-submit"
          ? "Submit the edited display name once and wait for a fresh Saved acknowledgment."
          : "Save the approved display name only after explicit approval.",
      kind: "functional",
      required: true,
      origin: "caller",
    },
  ];

  const requestId = `source-stop-${randomUUID()}`;

  const handle = await cli(
    [
      "fastloop",
      "verify",
      "--thread",
      threadId,
      "--request-id",
      requestId,
      "--url",
      fixture.url + "/settings",
      "--goal",
      scenario === "after-submit"
        ? "Enter PendingEdit, submit Save once, and wait for acknowledgment"
        : "Enter PendingEdit and wait for approval before saving",
      "--wait-ms",
      "0",
      "--requirements-json-stdin",
    ],
    JSON.stringify(requirements) + "\n",
  );

  assert.equal(handle.state, "accepted");
  assert.ok(handle.runId && handle.sessionId);
  process.stdout.write(
    JSON.stringify({ phase: "detached", runId: handle.runId, sessionId: handle.sessionId }) + "\n",
  );

  const typedResponse = await fetch(
    fixture.url + (scenario === "after-submit" ? "/await-saved" : "/await-typed"),
    {
      signal: AbortSignal.timeout(8500),
    },
  );

  assert.equal(typedResponse.status, 200);
  const before = await typedResponse.json();
  assert.equal(before.typedValue, "PendingEdit");
  assert.equal(before.saves, scenario === "after-submit" ? 1 : 0);
  await cli(["thread", "stop", threadId, "--json"]);

  const terminalResponse = await fetch(fixture.url + "/await-terminal?runId=" + handle.runId, {
    signal: AbortSignal.timeout(8500),
  });

  assert.equal(terminalResponse.status, 200);
  const terminal = await terminalResponse.json();
  assert.equal(terminal.state, "cancelled");
  assert.equal(terminal.result.verdict, "CANCELLED");
  const result = await cli(["fastloop", "result", "--thread", threadId, "--run", handle.runId]);
  assert.equal(result.state, "cancelled");
  assert.equal(result.result.requirementsHash, terminal.result.requirementsHash);
  assert.equal(result.result.checksHash, terminal.result.checksHash);
  assert.ok(
    result.result.checks.some(
      (check) => check.checkId === "saved" && ["UNKNOWN", "NOT_RUN"].includes(check.status),
    ),
  );
  const after = await (await fetch(fixture.url + "/truth")).json();
  assert.equal(after.saves, scenario === "after-submit" ? 1 : 0);
  assert.equal(after.typedValue, "PendingEdit");
  const actions = await (await fetch(fixture.url + "/actions?runId=" + handle.runId)).json();
  assert.ok(
    actions.actions.some(
      (action) => action.kind === "fill" && action.receipt?.effect === "confirmed",
    ),
  );
  assert.equal(
    actions.actions.filter((action) => action.kind === "click").length,
    scenario === "after-submit" ? 1 : 0,
  );
  const afterEvents = await cli(["thread", "log", threadId, "--json", "--limit", "100"]);

  const stops = afterEvents.filter(
    (event) => event.type === "system/thread/interrupted" && event.data.reason === "manual-stop",
  );

  assert.equal(stops.length, historicalStops.length + 1);

  const providerEvents = afterEvents.filter(
    (event) => event.type.startsWith("provider/") || event.type === "input/message/requested",
  );

  assert.equal(providerEvents.length, 0);

  const receipt = {
    surface:
      "actual isolated source Omnyo CLI detached admission and public Stop; authored planner fixture with real sealed engine/Chrome",
    nativeProviderQualification: false,
    phase:
      scenario === "after-submit"
        ? "after Save dispatch, during acknowledgment wait"
        : "after fill, before Save",
    passed: true,
    elapsedMs: performance.now() - start,
    packageSha256: JSON.parse(await readFile(join(root, "runtime.lock.json"), "utf8"))
      .packageSha256,
    runtimeDigest: fixture.runtimeDigest,
    producerPid: fixture.pid,
    threadId,
    requestId,
    runId: handle.runId,
    sessionId: handle.sessionId,
    historicalStopSequences: historicalStops.map((event) => event.seq),
    newStopSequence: stops.at(-1).seq,
    before,
    after,
    canonicalState: result.state,
    verdict: result.result.verdict,
    checks: result.result.checks,
    requirementsHash: result.result.requirementsHash,
    checksHash: result.result.checksHash,
    actions: actions.actions,
    providerCalls: 0,
    providerEvents: 0,
    clientTurnRequests: afterEvents.filter((event) => event.type === "client/turn/requested")
      .length,
  };

  if (explicitDataRoot) {
    assert(sourceUrl, "Source RPC URL required for retained evidence proof");
    assert.equal(receipt.clientTurnRequests, 0);
    const report = result.result.evidence.find((item) => item.relativePath === "report.md");
    assert(report, "Canonical report evidence is required");

    const response = await fetch(new URL("/api/v1/plugins/fastloop/rpc/readArtifact", sourceUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        runId: handle.runId,
        evidenceId: report.id,
        offset: 0,
        maxBytes: 262144,
      }),
      signal: AbortSignal.timeout(13000),
    });

    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.complete, true);
    receipt.retained = {
      canonicalJob: result,
      artifact: envelope.result,
      dataRoot: explicitDataRoot,
    };
  }

  await writeFile(evidencePath, JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      passed: true,
      runId: handle.runId,
      confirmedFill: true,
      saves: after.saves,
      verdict: result.result.verdict,
      evidence: evidencePath,
    }) + "\n",
  );
} catch (error) {
  proofFailure = error;
} finally {
  try {
    await cli(["plugin", "disable", "fastloop", "--json"]);
  } catch (error) {
    cleanupFailure = error;
  }

  producer.kill("SIGTERM");
  let cleanupTimer;

  try {
    await Promise.race([
      exited,
      new Promise(
        (_, reject) =>
          (cleanupTimer = setTimeout(() => {
            producer.kill("SIGKILL");
            reject(new Error("FIXTURE_CLEANUP_TIMEOUT"));
          }, 8000)),
      ),
    ]);
  } finally {
    clearTimeout(cleanupTimer);
  }
}

if (proofFailure || cleanupFailure)
  throw new AggregateError(
    [proofFailure, cleanupFailure].filter(Boolean),
    "DETACHED_STOP_PROOF_OR_CLEANUP_FAILED",
  );
