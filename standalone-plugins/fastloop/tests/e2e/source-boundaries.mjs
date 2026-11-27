import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const [sourceUrl, ownerThread, foreignThread, runId, output] = process.argv.slice(2);

assert(
  sourceUrl && ownerThread && foreignThread && runId && output,
  "Explicit isolated source boundary inputs required",
);

assert.notEqual(ownerThread, foreignThread);

assert(["127.0.0.1", "localhost"].includes(new URL(sourceUrl).hostname));

const cases = [
  {
    name: "foreign-thread-result",
    method: "getRun",
    input: { threadId: foreignThread, runId },
    status: 500,
    code: "handler_error",
    message: "RUN_CONTEXT_MISMATCH",
  },
  {
    name: "oversized-artifact-chunk",
    method: "readArtifact",
    input: { threadId: ownerThread, runId, evidenceId: "unknown", maxBytes: 262145 },
    status: 400,
    code: "invalid_input",
  },
  {
    name: "caller-host-override",
    method: "getRun",
    input: { threadId: ownerThread, runId, hostId: "arbitrary-localhost" },
    status: 400,
    code: "invalid_input",
  },
  {
    name: "caller-goal-code-injection",
    method: "getRun",
    input: { threadId: ownerThread, runId, code: "page.click('Save')" },
    status: 400,
    code: "invalid_input",
  },
];

const results = [];

for (const testcase of cases) {
  const start = performance.now();

  const response = await fetch(
    new URL(`/api/v1/plugins/fastloop/rpc/${testcase.method}`, sourceUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testcase.input),
      signal: AbortSignal.timeout(3000),
    },
  );

  const body = await response.json();
  assert.equal(response.status, testcase.status);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, testcase.code);

  if (testcase.message) assert.equal(body.error.message, testcase.message);
  results.push({
    name: testcase.name,
    status: response.status,
    code: body.error.code,
    elapsedMs: performance.now() - start,
  });
}

const receipt = {
  surface: "actual isolated source Omnyo owner RPC validation/ownership refusal",
  ownerThread,
  foreignThread,
  runId,
  cases: results,
  nativeProviderQualification: false,
  providerDispatches: 0,
  admissions: 0,
  browserLaunches: 0,
};

await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });

console.log(JSON.stringify({ output, cases: results.length }));
