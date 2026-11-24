import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [
  playwright,
  before,
  after,
  directory,
  scenario,
  start = "0",
  count = "1",
] = process.argv.slice(2);

if (!scenario)
  throw Error(
    "Usage: run.mjs playwright before-dist after-dist reports scenario.json [start] [count]",
  );

await mkdir(directory, { recursive: true });

const measure = resolve(dirname(fileURLToPath(import.meta.url)), "measure.mjs");

for (
  let trial = Number(start);
  trial < Number(start) + Number(count);
  trial++
) {
  for (const [profile, dist] of [
    ["before", before],
    ["after", after],
  ]) {
    const path = resolve(directory, `${profile}-${trial}.json`);

    const child = spawn(
      process.execPath,
      [measure, playwright, dist, path, profile, scenario],
      { stdio: ["ignore", "ignore", "inherit"] },
    );

    const deadline = setTimeout(() => child.kill("SIGTERM"), 55000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(deadline);

    if (code !== 0) throw Error(`Measurement failed: ${profile} ${trial}`);
    const result = JSON.parse(await readFile(path, "utf8"));
    console.log(
      JSON.stringify({
        profile,
        trial,
        passed: result.passed,
        chatVisibleMs: result.chatVisibleMs,
        webSocketOpenMs: result.webSocketOpenMs,
        chatSwitchMs: result.chatSwitchMs,
        chatReturnMs: result.chatReturnMs,
        settingsVisibleMs: result.settingsVisibleMs,
        staticRequests: result.staticRequests,
        encodedBodyBytes: result.staticEncodedBodyBytes,
        decodedBodyBytes: result.staticDecodedBodyBytes,
        optionalFailures: result.httpFailures.length,
      }),
    );
  }
}
