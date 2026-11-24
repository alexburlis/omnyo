import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  parseHarnessEfficiencyInput,
  reportHarnessEfficiency,
} from "../lib/harness-efficiency.js";
import { runMainIfEntrypoint } from "../lib/script-entry.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { input: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });

  if (!values.input)
    throw new Error("Usage: report-harness-efficiency --input PATH");
  const text = await readFile(values.input, "utf8");
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Input is not valid JSON");
  }

  const report = reportHarnessEfficiency(parseHarnessEfficiencyInput(value));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

runMainIfEntrypoint(import.meta.url, main);
