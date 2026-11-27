import { writeFile } from "node:fs/promises";

// Read the supported history API and retain only IDs, numeric counters, and
// bounded aggregate diagnostics. No prompt, reply, tool arguments, or account
// credentials are printed or written.
const args = process.argv.slice(2);

const threadId = args[0];

const outputPath = args[1];

const origin = args[2] ?? "http://127.0.0.1:38886";

const baseUrl = new URL(origin);

if (!threadId || !outputPath)
  throw new Error("Usage: audit-source.mjs <thread-id> <receipt-path> [loopback-origin]");

if (!["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname))
  throw new Error("Audit accepts only the local Omnyo public API");

const fields = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
];

const core = ["inputTokens", "outputTokens", "totalTokens"];

const numberFields = (value) =>
  Object.fromEntries(
    fields.map((key) => [
      key,
      Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null,
    ]),
  );

const turnLinks = new Map();

const streams = new Map();

const scopes = new Map();

const examples = [];

const streamAnomalies = [];

let afterSeq = 0;

let pageCount = 0;

let usageCount = 0;

let rootTurnCount = 0;

let nestedTurnCount = 0;

let acceptedRootCount = 0;

let sessionChanges = 0;

let crossScopeDrops = 0;

let optionalDrops = 0;

let naiveOutput = 0;

let naiveInput = 0;

let session = null;

let previous = null;

let previousScope = null;

let complete = false;

for (; pageCount < 100; pageCount++) {
  const url = new URL(`/api/v1/threads/${encodeURIComponent(threadId)}/events`, baseUrl);

  url.searchParams.set("types", "turn/started,turn/input/accepted,thread/tokenUsage/updated");
  url.searchParams.set("order", "asc");
  url.searchParams.set("limit", "100");
  url.searchParams.set("afterSeq", String(afterSeq));
  const response = await fetch(url);

  if (!response.ok) throw new Error(`History HTTP ${response.status}`);
  const rows = await response.json();

  if (!Array.isArray(rows)) throw new Error("History response is not an event array");

  if (rows.length === 0) {
    complete = true;
    break;
  }

  for (const row of rows) {
    afterSeq = Math.max(afterSeq, row.seq);
    const turnId = row.scope?.kind === "turn" ? row.scope.turnId : "thread";
    const providerThreadId = row.data?.providerThreadId ?? "";

    if (row.type === "turn/started") {
      const parent = row.data?.parentToolCallId;

      turnLinks.set(turnId, {
        nested: Boolean(parent),
        stream: parent
          ? `${providerThreadId}:agent:${parent}`
          : `${providerThreadId}:unvouched:${turnId}`,
      });

      if (parent) nestedTurnCount++;
      else rootTurnCount++;
      continue;
    }

    if (row.type === "turn/input/accepted") {
      const known = turnLinks.get(turnId);

      if (!known?.nested) {
        turnLinks.set(turnId, {
          nested: false,
          verifiedMain: true,
          stream: `${providerThreadId}:main`,
        });
        acceptedRootCount++;
      }

      continue;
    }

    if (row.type !== "thread/tokenUsage/updated") continue;
    usageCount++;
    const total = numberFields(row.data?.tokenUsage?.total);
    const last = numberFields(row.data?.tokenUsage?.last);
    const link = turnLinks.get(turnId);
    const key = link?.stream ?? `${providerThreadId}:unknown:${turnId}`;
    const prior = previous;

    const reset =
      session !== providerThreadId ||
      !prior ||
      fields.some(
        (field) => total[field] !== null && prior[field] !== null && total[field] < prior[field],
      );

    naiveOutput += reset
      ? (last.outputTokens ?? 0)
      : (total.outputTokens ?? 0) - (prior.outputTokens ?? 0);
    naiveInput += reset
      ? (last.inputTokens ?? 0)
      : (total.inputTokens ?? 0) - (prior.inputTokens ?? 0);

    if (prior && session !== providerThreadId) sessionChanges++;

    if (prior && previousScope !== turnId && core.some((field) => total[field] < prior[field]))
      crossScopeDrops++;

    if (
      prior &&
      !core.some((field) => total[field] < prior[field]) &&
      fields
        .slice(3)
        .some(
          (field) => total[field] !== null && prior[field] !== null && total[field] < prior[field],
        )
    )
      optionalDrops++;

    if (
      prior &&
      previousScope !== turnId &&
      examples.length < 12 &&
      total.outputTokens <= prior.outputTokens
    )
      examples.push({
        seq: row.seq,
        at: row.createdAt,
        session: providerThreadId,
        turnId,
        nested: link?.nested ?? null,
        totalOutput: total.outputTokens,
        lastOutput: last.outputTokens,
        previousTurnId: previousScope,
        previousOutput: prior.outputTokens,
      });

    let stream = streams.get(key);

    if (!stream) {
      stream = {
        key,
        nested: link?.nested ?? null,
        rows: 0,
        duplicates: 0,
        resets: 0,
        firstSeq: row.seq,
        lastSeq: row.seq,
        firstOutput: total.outputTokens,
        lastOutput: total.outputTokens,
        outputLowerBound: 0,
        inputLowerBound: 0,
        lastSumOutput: 0,
        seen: new Set(),
        baseline: null,
      };
      streams.set(key, stream);
    }

    stream.rows++;
    stream.lastSeq = row.seq;
    stream.lastOutput = total.outputTokens;
    const signature = JSON.stringify({ total, last });

    if (stream.seen.has(signature)) stream.duplicates++;
    else {
      stream.seen.add(signature);
      stream.lastSumOutput += last.outputTokens ?? 0;
    }

    const streamReset =
      !stream.baseline || core.some((field) => total[field] < stream.baseline[field]);

    if (
      stream.baseline &&
      streamAnomalies.length < 20 &&
      (streamReset || total.outputTokens - stream.baseline.outputTokens > last.outputTokens)
    )
      streamAnomalies.push({
        seq: row.seq,
        turnId,
        stream: key,
        nested: link?.nested ?? null,
        reset: streamReset,
        previous: stream.baseline,
        total,
        last,
      });

    if (stream.baseline && streamReset) stream.resets++;
    stream.outputLowerBound += streamReset
      ? (last.outputTokens ?? 0)
      : Math.max(0, total.outputTokens - stream.baseline.outputTokens);
    stream.inputLowerBound += streamReset
      ? (last.inputTokens ?? 0)
      : Math.max(0, total.inputTokens - stream.baseline.inputTokens);
    stream.baseline = total;

    const scope = scopes.get(turnId) ?? {
      turnId,
      nested: link?.nested ?? null,
      rows: 0,
      firstOutput: total.outputTokens,
      lastOutput: total.outputTokens,
    };

    scope.rows++;
    scope.lastOutput = total.outputTokens;
    scopes.set(turnId, scope);
    previous = total;
    previousScope = turnId;
    session = providerThreadId;
  }
}

const streamRows = [...streams.values()].map(
  ({ seen: _seen, baseline: _baseline, ...value }) => value,
);

const receipt = {
  checkedAt: new Date().toISOString(),
  surface: "Supported Omnyo public HTTP thread events API; numeric-only projection",
  threadId,
  complete,
  cap: { pages: 100, events: 10000 },
  pages: pageCount,
  usageCount,
  lastSeq: afterSeq,
  rootTurnCount,
  nestedTurnCount,
  acceptedRootCount,
  scopeCount: scopes.size,
  streamCount: streams.size,
  sessionChanges,
  crossScopeDrops,
  optionalDrops,
  naiveSingleBaseline: { input: naiveInput, output: naiveOutput },
  independentStreamsLowerBound: {
    input: streamRows.reduce((sum, value) => sum + value.inputLowerBound, 0),
    output: streamRows.reduce((sum, value) => sum + value.outputLowerBound, 0),
  },
  examples,
  streamAnomalies,
  streams: streamRows.sort((a, b) => b.outputLowerBound - a.outputLowerBound).slice(0, 32),
  scopes: [...scopes.values()].sort((a, b) => b.rows - a.rows).slice(0, 32),
  limitation:
    "Stream identity derives from surviving turn starts. Unknown or pruned starts remain separate lower bounds; this diagnostic is not provider billing proof.",
};

await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);

console.log(
  JSON.stringify({
    receipt: outputPath,
    complete,
    usageCount,
    roots: rootTurnCount,
    nested: nestedTurnCount,
    streams: streams.size,
    crossScopeDrops,
    optionalDrops,
    naiveOutput,
    streamOutputLowerBound: receipt.independentStreamsLowerBound.output,
  }),
);
