#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const lineage = [
  "native_fixture_lineage_source",
  "native_fixture_lineage_parent",
  "native_fixture_lineage_root",
];

if (process.env.PREDICTION_FIXTURE_ARGV_FILE)
  writeFileSync(
    process.env.PREDICTION_FIXTURE_ARGV_FILE,
    JSON.stringify(process.argv.slice(2)),
  );

const lines = createInterface({ input: process.stdin });

const children = new Set();

let predictionFailure = null;

let initializedClientName = null;

let sourceModel = "gpt-6.1-sol";

let predictionErrorInfo = "other";

let predictionStatus = "failed";

lines.on("close", async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          child.once("close", resolve);
          child.kill("SIGTERM");
        }),
    ),
  );
});

lines.on("line", (line) => {
  const request = JSON.parse(line);

  if (request.id === undefined) return;

  if (request.method === "initialize")
    initializedClientName = request.params?.clientInfo?.name ?? null;

  if (request.method === "malformed") {
    process.stdout.write("invalid-json\n");

    return;
  }

  if (request.method === "route-fixture") {
    const prefix =
      "model_providers.omnyo-account-pool.env_http_headers.x-omnyo-composer-prediction-token=";

    const configured = process.argv.find((value) => value.startsWith(prefix));

    const selectedEnvironmentName =
      configured === undefined
        ? null
        : JSON.parse(configured.slice(prefix.length));

    const capabilityPreserved =
      selectedEnvironmentName !== null &&
      process.env[selectedEnvironmentName] === "fixture";

    const canonicalPresent =
      process.env.OMNYO_COMPOSER_PREDICTION_CAPABILITY === "fixture";

    const modelProviderArgument = process.argv.find((value) =>
      value.startsWith("model_provider="),
    );

    const configuredModelProvider =
      modelProviderArgument === undefined
        ? null
        : JSON.parse(modelProviderArgument.slice("model_provider=".length));

    const legacyProviderConfigured = process.argv.some(
      (value) =>
        value === 'model_provider="bb-account-pool"' ||
        value.startsWith("model_providers.bb-account-pool."),
    );

    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { selectedEnvironmentName, capabilityPreserved, canonicalPresent, configuredModelProvider, legacyProviderConfigured, clientInfoName: initializedClientName } })}\n`,
    );

    return;
  }

  if (request.method === "thread/start") {
    const v = request.params;

    const valid =
      v.ephemeral === true &&
      v.model === "gpt-6.1-sol" &&
      v.modelProvider === "omnyo-account-pool" &&
      v.approvalPolicy === "never" &&
      v.sandbox === "read-only" &&
      v.developerInstructions.includes("Ship the repair.") &&
      v.config["agents.enabled"] === false;

    process.stdout.write(
      `${JSON.stringify(valid ? { id: request.id, result: { thread: { id: "native_fixture_child" }, model: v.model, modelProvider: v.modelProvider } } : { id: request.id, error: { code: -32600 } })}\n`,
    );

    return;
  }

  if (request.method === "thread/read") {
    if (request.params.threadId === "native_fixture_missing_rollout") {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not loaded: ${request.params.threadId}` } })}\n`,
      );

      return;
    }

    const index = lineage.indexOf(request.params.threadId);

    const forkedFromId =
      request.params.threadId === "native_fixture_deleted_ancestor"
        ? "native_fixture_deleted_ancestor_file"
        : request.params.threadId === "native_fixture_lineage_cycle"
          ? request.params.threadId
          : index < 0
            ? null
            : (lineage[index + 1] ?? null);

    const path = [
      "native_fixture_deleted_rollout",
      "native_fixture_deleted_ancestor_file",
    ].includes(request.params.threadId)
      ? fileURLToPath(
          new URL(`./${request.params.threadId}.jsonl`, import.meta.url),
        )
      : index < 0
        ? fileURLToPath(import.meta.url)
        : join(
            process.env.PREDICTION_FIXTURE_LINEAGE_DIR,
            `${request.params.threadId}.jsonl`,
          );

    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId, path, forkedFromId, model: request.params.threadId === "native_fixture_unsupported_model" ? "gpt-5.4" : "gpt-6.1-sol" } } })}\n`,
    );

    return;
  }

  if (request.method === "thread/resume") {
    const v = request.params;

    if (
      v.threadId === lineage[0] &&
      !lineage.every((id) => {
        const path = join(process.env.CODEX_HOME, "sessions", `${id}.jsonl`);

        return existsSync(path) && readFileSync(path, "utf8") === id;
      })
    ) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32600, message: "invalid paginated history lineage for 11111111-2222-4333-8444-555555555555: missing source rollout" } })}\n`,
      );

      return;
    }

    if (
      v.threadId === "native_fixture_missing_lineage" ||
      v.threadId === "native_fixture_invalid_resume"
    ) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32600, message: v.threadId === "native_fixture_missing_lineage" ? "invalid paginated history lineage for 11111111-2222-4333-8444-555555555555: missing source rollout" : "Untrusted request detail" } })}\n`,
      );

      return;
    }

    sourceModel = v.model;

    const valid =
      ["gpt-5.4", "gpt-6.1-sol"].includes(v.model) &&
      v.modelProvider === "omnyo-account-pool" &&
      v.approvalPolicy === "never" &&
      v.sandbox === "read-only" &&
      v.excludeTurns === true;

    process.stdout.write(
      `${JSON.stringify(valid ? { id: request.id, result: { thread: { id: v.threadId }, model: v.model, modelProvider: v.modelProvider } } : { id: request.id, error: { code: -32600 } })}\n`,
    );

    return;
  }

  if (request.method === "thread/fork") {
    const v = request.params;

    predictionFailure = [
      "native_fixture_payload_rejected",
      "native_fixture_payload_tools",
    ].includes(v.threadId)
      ? JSON.stringify({
          error: {
            message:
              "Prediction payload must use the provider prediction prompt and supported function declarations" +
              (v.threadId === "native_fixture_payload_tools"
                ? " (reason=tools)"
                : ""),
          },
        })
      : [
            "native_fixture_private_failure",
            "native_fixture_http_failure",
            "native_fixture_unknown_failure",
            "native_fixture_invalid_http_failure",
            "native_fixture_private_status",
          ].includes(v.threadId)
        ? "Untrusted provider diagnostic with arbitrary private content"
        : null;

    predictionErrorInfo =
      v.threadId === "native_fixture_http_failure"
        ? { responseStreamDisconnected: { httpStatusCode: 401 } }
        : v.threadId === "native_fixture_invalid_http_failure"
          ? { responseStreamDisconnected: { httpStatusCode: 99999 } }
          : v.threadId === "native_fixture_unknown_failure"
            ? "Untrusted provider error code"
            : "other";
    predictionStatus =
      v.threadId === "native_fixture_private_status"
        ? "Untrusted provider status"
        : "failed";

    const valid =
      [
        "native_fixture_source",
        "native_fixture_original_pool_result_v1",
        "native_fixture_unknown_pool_result",
        "native_fixture_lineage_source",
        "native_fixture_changed_model",
        "native_fixture_payload_rejected",
        "native_fixture_payload_tools",
        "native_fixture_unsupported_model",
        "native_fixture_private_failure",
        "native_fixture_http_failure",
        "native_fixture_unknown_failure",
        "native_fixture_invalid_http_failure",
        "native_fixture_private_status",
      ].includes(v.threadId) &&
      v.ephemeral === true &&
      v.experimentalPredictionMode === true &&
      v.approvalPolicy === undefined &&
      v.sandbox === undefined &&
      v.modelProvider === undefined &&
      v.config === undefined;

    const resultProvider =
      v.threadId === "native_fixture_original_pool_result_v1"
        ? "bb-account-pool"
        : v.threadId === "native_fixture_unknown_pool_result"
          ? "user-owned-provider"
          : "omnyo-account-pool";

    process.stdout.write(
      `${JSON.stringify(valid ? { id: request.id, result: { thread: { id: "native_fixture_child" }, model: v.threadId === "native_fixture_changed_model" ? "gpt-6-sol" : sourceModel, modelProvider: resultProvider } } : { id: request.id, error: { code: -32600, message: "Prediction mode rejects configuration overrides" } })}\n`,
    );

    return;
  }

  if (request.method === "turn/start") {
    const v = request.params;

    if (
      v.threadId !== "native_fixture_child" ||
      v.turnTrigger !== "composer_predictions" ||
      v.environments?.length !== 0 ||
      (process.env.PREDICTION_FIXTURE_REQUIRE_SCHEMA !== undefined &&
        (v.outputSchema?.type !== "object" ||
          !v.outputSchema.required?.includes("noSuggestionReason") ||
          !v.outputSchema.required?.includes("archiveReadiness"))) ||
      (process.env.PREDICTION_FIXTURE_REQUIRE_SCHEMA === "reply" &&
        (v.outputSchema.properties?.suggestion?.type !== "string" ||
          !(v.outputSchema.properties.suggestion.minLength >= 1)))
    ) {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32600 } })}\n`,
      );

      return;
    }

    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { turn: { id: "turn_fixture" } } })}\n`,
    );

    if (predictionFailure !== null) {
      const error = {
        message: predictionFailure,
        codexErrorInfo: predictionErrorInfo,
        additionalDetails: "Untrusted private additional details",
      };

      process.stdout.write(
        `${JSON.stringify({ method: "error", params: { threadId: v.threadId, turnId: "turn_fixture", error, willRetry: false } })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ method: "turn/completed", params: { threadId: v.threadId, turn: { id: "turn_fixture", status: predictionStatus, error } } })}\n`,
      );

      return;
    }

    process.stdout.write(
      `${JSON.stringify({ method: "item/completed", params: { threadId: v.threadId, turnId: "turn_fixture", item: { type: "agentMessage", text: process.env.PREDICTION_FIXTURE_RESULT ?? JSON.stringify({ suggestion: "Check the result.", noSuggestionReason: null, archiveReadiness: process.env.PREDICTION_FIXTURE_ARCHIVE ? JSON.parse(process.env.PREDICTION_FIXTURE_ARCHIVE) : { ready: false, reason: "The requested check is still pending." }, ...(process.env.PREDICTION_FIXTURE_TAG ? { tag: JSON.parse(process.env.PREDICTION_FIXTURE_TAG) } : {}) }) } } })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ method: "turn/completed", params: { threadId: v.threadId, turn: { id: "turn_fixture", status: "completed" } } })}\n`,
    );

    return;
  }

  if (request.method === "hang") return;

  if (request.method === "fail") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, error: { code: -32601, message: "unsupported fixture request" } })}\n`,
    );

    return;
  }

  let result = request.method === "pid" ? { pid: process.pid } : request.params;

  if (request.method === "owned-helper") {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );

    children.add(child);
    child.once("close", () => children.delete(child));
    result = { pid: child.pid };
  }

  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }, request.params?.delay ?? 0);
});
