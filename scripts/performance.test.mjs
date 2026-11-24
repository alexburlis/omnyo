import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./performance.mjs", import.meta.url));

const root = fileURLToPath(new URL("../", import.meta.url));

const cases = [
  [
    "recognizes browser-actions before requiring output",
    ["--diagnostic", "browser-actions"],
    /Error: Required: --output/u,
  ],
  [
    "recognizes history-navigation before requiring output",
    ["--diagnostic", "history-navigation"],
    /Error: Required: --output/u,
  ],
  [
    "refuses browser-actions baseline comparison before requiring output",
    ["--diagnostic", "browser-actions", "--baseline", "baseline.json"],
    /Error: Diagnostic must be .*cannot compare\/promote baselines/u,
  ],
  [
    "refuses history-navigation baseline comparison before requiring output",
    ["--diagnostic", "history-navigation", "--baseline", "baseline.json"],
    /Error: Diagnostic must be .*cannot compare\/promote baselines/u,
  ],
  [
    "refuses an unknown diagnostic before requiring output",
    ["--diagnostic", "unknown-mode"],
    /Error: Diagnostic must be /u,
  ],
];

for (const [name, args, expected] of cases)
  test(name, () => {
    const result = spawnSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", script, "run", ...args],
      { cwd: root, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
  });
