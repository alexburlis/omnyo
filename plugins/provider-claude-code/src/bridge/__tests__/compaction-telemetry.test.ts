import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  startCompactionTelemetryReceiver,
  type CompactionTelemetryReceiver,
} from "../compaction-telemetry.js";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../__fixtures__/otlp-api-request-logs.json",
);

const COMPACT_EVENT_AT_MS = Date.UTC(2100, 0, 1, 0, 0, 2);

function recordedLogs(sessionId: string): string {
  return readFileSync(FIXTURE_PATH, "utf8").replaceAll("SESSION_ID", sessionId);
}

function authorizationHeader(receiver: CompactionTelemetryReceiver): string {
  const header = receiver.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? "";
  const separator = header.indexOf("=");

  expect(header.slice(0, separator)).toBe("Authorization");

  return header.slice(separator + 1);
}

async function postLogs(
  receiver: CompactionTelemetryReceiver,
  body: string,
  authorization: string | null,
): Promise<Response> {
  return fetch(receiver.logsEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    body,
  });
}

describe("compaction telemetry receiver", () => {
  const receivers: CompactionTelemetryReceiver[] = [];

  afterEach(async () => {
    await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
  });

  async function startReceiver(): Promise<CompactionTelemetryReceiver> {
    const receiver = await startCompactionTelemetryReceiver();
    receivers.push(receiver);

    return receiver;
  }

  it("configures Claude Code to export logs only to its loopback endpoint", async () => {
    const receiver = await startReceiver();

    expect(receiver.logsEndpoint).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/,
    );
    expect(receiver.env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: receiver.logsEndpoint,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: expect.stringMatching(
        /^Authorization=Bearer [0-9a-f]{48}$/,
      ),
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
    });
  });

  it("leaves the host's metrics, traces and generic exporter settings in place", async () => {
    const receiver = await startReceiver();

    const hostEnv = {
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer host",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    };

    const sessionEnv = { ...hostEnv, ...receiver.sessionEnv(hostEnv) };

    expect(sessionEnv).toMatchObject(hostEnv);
    expect(receiver.reaches(sessionEnv)).toBe(true);
    expect(receiver.sessionEnv({})).toMatchObject({
      OTEL_METRICS_EXPORTER: "none",
    });
    expect(
      receiver.reaches({
        ...sessionEnv,
        CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      }),
    ).toBe(false);
    expect(
      receiver.reaches({
        ...sessionEnv,
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer other",
      }),
    ).toBe(false);
  });

  it.each([
    ["a missing bearer header", null],
    ["a wrong bearer token", "Bearer 0000"],
  ])("rejects %s and records nothing", async (_name, authorization) => {
    const receiver = await startReceiver();

    const response = await postLogs(
      receiver,
      recordedLogs("session-a"),
      authorization,
    );

    expect(response.status).toBe(401);
    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-a",
        sinceMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
  });

  it("keeps only the compact api_request numbers from a recorded export", async () => {
    const receiver = await startReceiver();

    const response = await postLogs(
      receiver,
      recordedLogs("session-a"),
      authorizationHeader(receiver),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-a",
        sinceMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toEqual({
      sessionId: "session-a",
      inputTokens: 10,
      outputTokens: 2_500,
      cacheReadTokens: 91_200,
      cacheCreationTokens: 800,
      cacheCreation1hTokens: 800,
      observedAtMs: COMPACT_EVENT_AT_MS,
    });
    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-a",
        sinceMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
  });

  it("ignores events from other sessions and from before the compaction started", async () => {
    const receiver = await startReceiver();
    await postLogs(
      receiver,
      recordedLogs("session-a"),
      authorizationHeader(receiver),
    );

    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-b",
        sinceMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-a",
        sinceMs: COMPACT_EVENT_AT_MS + 1,
        timeoutMs: 50,
      }),
    ).resolves.toBeNull();
  });

  it("reads a gzip-compressed export", async () => {
    const receiver = await startReceiver();

    const response = await fetch(receiver.logsEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        authorization: authorizationHeader(receiver),
      },
      body: gzipSync(recordedLogs("session-a")),
    });

    expect(response.status).toBe(200);
    await expect(
      receiver.waitForCompactionUsage({
        sessionId: "session-a",
        sinceMs: 0,
        timeoutMs: 50,
      }),
    ).resolves.toMatchObject({ outputTokens: 2_500 });
  });

  it("delivers an event that arrives while a compaction is waiting", async () => {
    const receiver = await startReceiver();

    const waiting = receiver.waitForCompactionUsage({
      sessionId: "session-a",
      sinceMs: 0,
      timeoutMs: 5_000,
    });

    await postLogs(
      receiver,
      recordedLogs("session-a"),
      authorizationHeader(receiver),
    );

    await expect(waiting).resolves.toMatchObject({
      sessionId: "session-a",
      outputTokens: 2_500,
    });
  });

  it("answers malformed and foreign requests without recording usage", async () => {
    const receiver = await startReceiver();
    const authorization = authorizationHeader(receiver);

    expect((await postLogs(receiver, "{", authorization)).status).toBe(400);
    expect(
      (
        await fetch(receiver.logsEndpoint.replace("/v1/logs", "/v1/metrics"), {
          method: "POST",
          headers: { authorization },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect((await postLogs(receiver, "{}", authorization)).status).toBe(200);
  });
});
