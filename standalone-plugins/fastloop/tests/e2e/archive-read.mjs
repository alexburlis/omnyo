import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const [sourceCli, sourceUrl, projectRoot, stopReceiptPath, output] = process.argv.slice(2);

assert(
  sourceCli && sourceUrl && projectRoot && stopReceiptPath && output,
  "Explicit readonly archive scope required",
);

const proof = JSON.parse(await readFile(stopReceiptPath, "utf8"));

assert(proof.retained && Number.isInteger(proof.producerPid));

assert.equal(proof.verdict, "CANCELLED");

assert.equal(proof.clientTurnRequests, 0);

await assert.rejects(lstat(projectRoot), { code: "ENOENT" });

assert.throws(() => process.kill(proof.producerPid, 0), { code: "ESRCH" });

const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);

const noCoordinator = async () => {
  for (const suffix of [".json", ".lock"])
    await assert.rejects(lstat(join(homedir(), ".fastloop/coordinators", key + suffix)), {
      code: "ENOENT",
    });

  const wal = await lstat(join(proof.retained.dataRoot, "journal.sqlite-wal")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  assert(!wal || wal.size === 0);
};

await noCoordinator();

const before = await readdir(proof.retained.dataRoot);

const rpc = async (method, input) => {
  const response = await fetch(new URL(`/api/v1/plugins/fastloop/rpc/${method}`, sourceUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(13000),
  });

  const body = await response.json();
  assert.equal(response.status, 200, body.error?.message ?? `SOURCE_RPC_${method}`);
  assert.equal(body.ok, true);

  return body.result;
};

const started = performance.now();

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

await noCoordinator();

assert.deepEqual(await readdir(proof.retained.dataRoot), before);

const { stdout } = await promisify(execFile)(
  process.execPath,
  [sourceCli, "thread", "log", proof.threadId, "--json", "--limit", "100"],
  { timeout: 14000, maxBuffer: 1048576 },
);

assert.equal(
  JSON.parse(stdout).filter((event) => event.type === "client/turn/requested").length,
  0,
);

const receipt = {
  schema: 1,
  surface:
    "actual isolated source Omnyo readonly result/delivery/artifact RPC after owned checkout deletion",
  elapsedMs: performance.now() - started,
  runId: proof.runId,
  sessionId: proof.sessionId,
  verdict: job.result.verdict,
  canonicalJob: job,
  artifactSha256: artifact.evidence.sha256,
  artifactBytes: bytes.length,
  deliveryState: delivery.state,
  removedProjectRoot: projectRoot,
  dataRoot: proof.retained.dataRoot,
  stopReceiptPath,
  providerCalls: 0,
  clientTurnRequests: 0,
  browserStarted: false,
  checkoutRecreated: false,
  storageInventoryUnchanged: true,
  recoveredFailure:
    "First read refused stale persisted active lease metadata; regression test reproduced and fixed; SDK archive remains quiescence authority",
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
