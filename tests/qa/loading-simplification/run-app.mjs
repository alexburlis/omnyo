import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [
  playwright,
  before,
  after,
  resultDirectory,
  threadPath,
  readyText,
  start = "0",
  count = "1",
  cacheProfile,
] = process.argv.slice(2);

if (!readyText)
  throw Error(
    "Usage: run-app.mjs playwright before-dist after-dist results thread-path ready-text [start] [count] [production]",
  );

await mkdir(resultDirectory, { recursive: true });

const measure = resolve(dirname(fileURLToPath(import.meta.url)), "app.mjs");

for (let trial = Number(start); trial < Number(start) + Number(count); trial++)
  for (const [label, dist] of [
    ["before", before],
    ["after", after],
  ]) {
    const output = resolve(resultDirectory, `app-${label}-${trial}.json`);

    const child = spawn(
      process.execPath,
      [
        measure,
        playwright,
        dist,
        output,
        threadPath,
        readyText,
        ...(cacheProfile ? [cacheProfile] : []),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );

    const code = await new Promise((resolve) => child.once("exit", resolve));

    if (code !== 0) throw Error("App measurement failed");
    const row = JSON.parse(await readFile(output, "utf8"));
    console.log(JSON.stringify({ label, trial, ...row, requests: undefined }));
  }
