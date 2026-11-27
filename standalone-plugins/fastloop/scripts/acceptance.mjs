import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateNativeRepairEvidence } from "../acceptance-evidence.ts";

const [mode, indexPath] = process.argv.slice(2).filter((value) => value !== "--");

if (!["omnyo-core", "omnyo-full"].includes(mode))
  throw new Error("Expected omnyo-core or omnyo-full and an optional absolute evidence index");

const { stdout } = await promisify(execFile)(
  process.execPath,
  [
    "scripts/test.mjs",
    "tests/routing.test.ts",
    "tests/cli.test.ts",
    "tests/host-lifecycle.test.ts",
    "tests/session-ownership.test.ts",
    "tests/retained-host.test.ts",
    "tests/retained-storage.test.ts",
    "tests/bridge.test.ts",
    "tests/completion.test.ts",
    "tests/app.test.tsx",
    "tests/acceptance-evidence.test.ts",
  ],
  { timeout: 14500, maxBuffer: 1048576 },
);

process.stdout.write(stdout);

if (!indexPath) {
  console.log(
    JSON.stringify({
      mode,
      status: "BLOCKED",
      offline: "passed",
      code: "NATIVE_REPAIR_EVIDENCE_INDEX_REQUIRED",
      providerDispatches: 0,
    }),
  );
  process.exitCode = 2;
} else {
  try {
    const native = await validateNativeRepairEvidence(
      JSON.parse(await readFile(indexPath, "utf8")),
    );

    const report = {
      mode,
      status: mode === "omnyo-core" ? "PASSED" : "BLOCKED",
      native,
      providerDispatches: 0,
    };

    if (mode === "omnyo-full") report.code = "FULL_NATIVE_FLOW_MATRIX_REQUIRED";
    console.log(JSON.stringify(report));

    if (mode === "omnyo-full") process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify({
        mode,
        status: "BLOCKED",
        code:
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "EVIDENCE_INVALID",
        providerDispatches: 0,
      }),
    );
    process.exitCode = 2;
  }
}
