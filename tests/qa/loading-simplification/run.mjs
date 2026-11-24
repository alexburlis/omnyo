import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [playwright, before, after, resultDirectory, scenario = "healthy"] =
  process.argv.slice(2);

if (!resultDirectory)
  throw Error(
    "Usage: run.mjs playwright before after results [healthy|slow] [start] [count]",
  );

await mkdir(resultDirectory, { recursive: true });

const measure = resolve(dirname(fileURLToPath(import.meta.url)), "measure.mjs");

const rows = [];

const startTrial = Number(process.argv[7] ?? 0);

const trialCount = Number(process.argv[8] ?? 5);

for (let trial = startTrial; trial < startTrial + trialCount; trial++)
  for (const [label, build] of [
    ["before", before],
    ["after", after],
  ]) {
    const output = resolve(
      resultDirectory,
      `${scenario}-${label}-${trial}.json`,
    );

    const child = spawn(
      process.execPath,
      [measure, playwright, build, output, scenario, String(trial)],
      { stdio: ["ignore", "ignore", "inherit"] },
    );

    const code = await new Promise((resolve) => child.once("exit", resolve));

    if (code !== 0) throw Error("Measurement process failed");
    const row = JSON.parse(await readFile(output, "utf8"));
    rows.push({ label, ...row });
  }

const summarize = (values) => {
  values.sort((a, b) => a - b);

  return {
    median: values[Math.floor(values.length / 2)],
    min: values[0],
    max: values.at(-1),
  };
};

const summary = {
  scenario,
  trialsPerVariant: trialCount,
  units: "HTTP response-body bytes and milliseconds; 750ms idle observation",
  results: {},
};

for (const label of ["before", "after"]) {
  const selected = rows.filter((r) => r.label === label);
  summary.results[label] = {
    errors: selected.filter(
      (r) => r.error || r.failedResponses || r.pageErrors.length,
    ).length,
    chatReadyMs: summarize(selected.map((r) => r.chatReadyMs)),
    featureReadyMs: summarize(selected.map((r) => r.featureReadyMs)),
    idleOptionalRequests: summarize(
      selected.map((r) => r.beforeIntent.optionalRequests),
    ),
    idleBodyBytes: summarize(selected.map((r) => r.beforeIntent.bytes)),
    totalBodyBytes: summarize(selected.map((r) => r.totalBytes)),
    draftPreserved: selected.every((r) => r.draft === "keep my draft"),
  };
}

await writeFile(
  resolve(
    resultDirectory,
    `${scenario}-summary-${startTrial}-${trialCount}.json`,
  ),
  JSON.stringify(summary, null, 2),
);

console.log(JSON.stringify(summary));
