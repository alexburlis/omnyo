import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const [sourceCli, sourceUrl, projectRoot, stopReceiptPath, output] = process.argv.slice(2);

assert(
  sourceCli && sourceUrl && projectRoot && stopReceiptPath && output,
  "Explicit owned archive proof inputs required",
);

const proof = JSON.parse(await readFile(stopReceiptPath, "utf8"));

assert(proof.retained, "Persistent-root Stop receipt is required");

assert.equal(proof.canonicalState, "cancelled");

assert.equal(proof.verdict, "CANCELLED");

assert.equal(proof.clientTurnRequests, 0);

assert.notEqual(proof.retained.dataRoot, join(projectRoot, ".fastloop"));

const marker = JSON.parse(await readFile(join(projectRoot, "owner.json"), "utf8"));

assert.equal(marker.owner, "/root/controller");

assert.equal(marker.purpose, "FastLoop BB archive acceptance disposable checkout");

assert.deepEqual((await readdir(projectRoot)).sort(), [".fastloop", "owner.json"]);

assert.deepEqual(await readdir(join(projectRoot, ".fastloop")), ["config.json"]);

const beforeConfig = await readFile(join(projectRoot, ".fastloop/config.json"));

const exec = promisify(execFile);

const cli = async (args) => {
  const result = await exec(process.execPath, [sourceCli, ...args], {
    timeout: 14000,
    maxBuffer: 1048576,
  });

  return JSON.parse(result.stdout);
};

const rpc = async (method, input) => {
  const response = await fetch(new URL(`/api/v1/plugins/fastloop/rpc/${method}`, sourceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(13000),
  });

  const body = await response.json();
  assert.equal(response.status, 200, `SOURCE_RPC_${method}_${response.status}`);
  assert.equal(body.ok, true);

  return body.result;
};

const dataFilesBefore = await readdir(proof.retained.dataRoot);

const runFilesBefore = await readdir(join(proof.retained.dataRoot, "runs", proof.runId));

const wal = await lstat(join(proof.retained.dataRoot, "journal.sqlite-wal")).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});

assert(!wal || wal.size === 0, "Producer journal must be quiescent/checkpointed");

assert(Number.isInteger(proof.producerPid));

assert.throws(() => process.kill(proof.producerPid, 0), { code: "ESRCH" });

const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);

for (const suffix of [".json", ".lock"])
  await assert.rejects(lstat(join(homedir(), ".fastloop/coordinators", key + suffix)), {
    code: "ENOENT",
  });

await rm(projectRoot, { recursive: true });

await assert.rejects(lstat(projectRoot), { code: "ENOENT" });

let enabled = false;

try {
  await cli(["plugin", "enable", "fastloop", "--json"]);
  enabled = true;
  const job = await rpc("getRun", { threadId: proof.threadId, runId: proof.runId });
  assert.deepEqual(job, proof.retained.canonicalJob);
  const delivery = await rpc("getDelivery", { threadId: proof.threadId, runId: proof.runId });
  assert(["none", "suppressed"].includes(delivery.state));
  const expected = proof.retained.artifact;

  const artifact = await rpc("readArtifact", {
    threadId: proof.threadId,
    runId: proof.runId,
    evidenceId: expected.evidenceId,
    offset: 0,
    maxBytes: 262144,
  });

  assert.deepEqual(artifact, expected);
  const bytes = Buffer.from(artifact.bytesBase64, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.evidence.sha256);
  await assert.rejects(lstat(projectRoot), { code: "ENOENT" });

  for (const suffix of [".json", ".lock"])
    await assert.rejects(lstat(join(homedir(), ".fastloop/coordinators", key + suffix)), {
      code: "ENOENT",
    });
  assert.deepEqual(await readdir(proof.retained.dataRoot), dataFilesBefore);
  assert.deepEqual(
    await readdir(join(proof.retained.dataRoot, "runs", proof.runId)),
    runFilesBefore,
  );
  const events = await cli(["thread", "log", proof.threadId, "--json", "--limit", "100"]);
  assert.equal(events.filter((event) => event.type === "client/turn/requested").length, 0);

  const receipt = {
    schema: 1,
    surface:
      "actual source Omnyo result/artifact RPC through public read-only archive after owned checkout deletion",
    runId: proof.runId,
    sessionId: proof.sessionId,
    verdict: job.result.verdict,
    dataRoot: proof.retained.dataRoot,
    removedProjectRoot: projectRoot,
    policySha256: createHash("sha256").update(beforeConfig).digest("hex"),
    canonicalJob: job,
    artifactSha256: artifact.evidence.sha256,
    artifactBytes: bytes.length,
    deliveryState: delivery.state,
    clientTurnRequests: 0,
    providerCalls: 0,
    browserStarted: false,
    checkoutRecreated: false,
    storageInventoryUnchanged: true,
    stopReceiptPath,
  };

  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({
      output,
      runId: proof.runId,
      verdict: job.result.verdict,
      artifactSha256: artifact.evidence.sha256,
    }),
  );
} finally {
  if (enabled) await cli(["plugin", "disable", "fastloop", "--json"]);
}
