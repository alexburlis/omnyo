import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createConnection } from "@omnyo/db";
import { OmnyoStateWorkPendingError } from "@omnyo/server-archive";
import {
  stageIdentityAdoptionV1,
  preflightIdentityAdoptionV1,
  preflightIdentityAdoptionDatabaseV1,
  verifyIdentityAdoptionDatabaseV1,
  rollBackIdentityAdoptionV1,
} from "./services/maintenance/omnyo-identity-controller-v1.js";

async function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: "string" },
      "request-file": { type: "string" },
      "request-sha256": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (
    (values.phase !== "preflight" &&
      values.phase !== "preflight-database" &&
      values.phase !== "verify-database" &&
      values.phase !== "stage" &&
      values.phase !== "rollback") ||
    !values["request-file"]
  )
    throw new Error(
      "Use --phase preflight|preflight-database|stage|verify-database|rollback --request-file with the exact owned identity request",
    );
  const raw = await readFile(values["request-file"], "utf8");

  if (
    createHash("sha256").update(raw).digest("hex") !== values["request-sha256"]
  )
    throw new Error("Identity control request changed after selection");
  const request: unknown = JSON.parse(raw);

  if (values.phase === "preflight") {
    const db = createConnection(":memory:");
    db.$client.close();
    process.stdout.write(
      JSON.stringify(await preflightIdentityAdoptionV1(request)) + "\n",
    );

    return;
  }

  const execute = {
    "preflight-database": preflightIdentityAdoptionDatabaseV1,
    "verify-database": verifyIdentityAdoptionDatabaseV1,
    stage: stageIdentityAdoptionV1,
    rollback: rollBackIdentityAdoptionV1,
  }[values.phase];

  const result = await execute(request);

  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((error: unknown) => {
  if (error instanceof OmnyoStateWorkPendingError) {
    process.stdout.write(
      JSON.stringify({
        version: 1,
        status: "pending",
        progress: error.progress,
      }) + "\n",
    );

    return;
  }

  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
});
