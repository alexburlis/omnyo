import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [directory, output] = process.argv.slice(2);

if (!output) throw Error("Usage: summarize.mjs report-directory summary.json");

const summary = {};

for (const profile of ["before", "after"]) {
  const files = (await readdir(directory)).filter((file) =>
    new RegExp(`^${profile}-\\d+\\.json$`).test(file),
  );

  const results = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(resolve(directory, file), "utf8")),
    ),
  );

  if (results.length === 0) throw Error("No measurement records");

  if (results.some((result) => !result.passed || !result.cleaned))
    throw Error("Failed or unclean measurement");
  summary[profile] = {
    trials: results.length,
    optionalHttpFailures: results.map((result) => result.httpFailures),
    teardownFailures: results.map((result) => result.teardownFailures),
    metrics: {},
  };

  const endpoints = new Map();

  for (const result of results) {
    for (const request of result.requests) {
      if (
        request.kind !== "api" ||
        request.phase === "teardown" ||
        !Number.isFinite(request.totalMs)
      )
        continue;
      const key = request.method + " " + request.path;

      if (!endpoints.has(key)) endpoints.set(key, []);
      endpoints.get(key).push(request);
    }
  }

  summary[profile].endpoints = [...endpoints].map(([path, requests]) => {
    const durations = requests
      .map((request) => request.totalMs)
      .sort((a, b) => a - b);

    return {
      path,
      count: requests.length,
      failures: requests.filter((request) => request.status >= 400).length,
      medianMs: durations[Math.floor(durations.length / 2)],
      minMs: durations[0],
      maxMs: durations.at(-1),
    };
  });

  for (const key of [
    "chatVisibleMs",
    "webSocketOpenMs",
    "chatSwitchMs",
    "chatReturnMs",
    "settingsVisibleMs",
    "staticRequests",
    "staticUniqueAssets",
    "staticEncodedBodyBytes",
    "staticDecodedBodyBytes",
    "coldStaticEncodedBodyBytes",
    "coldStaticDecodedBodyBytes",
  ]) {
    const values = results.map((result) => result[key]).sort((a, b) => a - b);

    if (values.some((value) => !Number.isFinite(value)))
      throw Error(`Invalid metric: ${key}`);
    summary[profile].metrics[key] = {
      median: values[Math.floor(values.length / 2)],
      min: values[0],
      max: values.at(-1),
    };
  }
}

await writeFile(output, JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary));
