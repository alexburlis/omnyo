import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [directory, output] = process.argv.slice(2);

if (!output) throw Error("Usage: summarize.mjs records-directory output.json");

const files = await readdir(directory);

const records = await Promise.all(
  files
    .filter((file) =>
      /^(app|healthy|slow)-(before|after)-\d+\.json$/.test(file),
    )
    .map(async (file) => ({
      file,
      ...JSON.parse(await readFile(resolve(directory, file), "utf8")),
    })),
);

const summarize = (values) => {
  const sorted = values.toSorted((a, b) => a - b);

  return {
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted.at(-1),
  };
};

const report = {};

for (const scenario of ["app", "healthy", "slow"]) {
  report[scenario] = {};

  for (const variant of ["before", "after"]) {
    const rows = records.filter((row) =>
      row.file.startsWith(`${scenario}-${variant}-`),
    );

    if (!rows.length) continue;

    if (
      rows.some(
        (row) =>
          row.error ||
          row.pageErrors?.length ||
          row.errors?.length ||
          row.httpFailures?.length ||
          row.failedResponses,
      )
    )
      throw Error(`Failed ${scenario} ${variant} trial`);

    const fields =
      scenario === "app"
        ? ["chatVisibleMs", "staticRequests", "staticBodyBytes", "assets"]
        : ["chatReadyMs", "featureReadyMs", "totalBytes"];

    report[scenario][variant] = {
      trials: rows.length,
      ...Object.fromEntries(
        fields.map((field) => [
          field,
          summarize(rows.map((row) => row[field])),
        ]),
      ),
    };

    if (scenario !== "app") {
      report[scenario][variant].idleOptionalRequests = summarize(
        rows.map((row) => row.beforeIntent.optionalRequests),
      );
      report[scenario][variant].idleBodyBytes = summarize(
        rows.map((row) => row.beforeIntent.bytes),
      );
      report[scenario][variant].draftPreserved = rows.every(
        (row) => row.draft === "keep my draft",
      );
    }
  }
}

await writeFile(output, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report));
