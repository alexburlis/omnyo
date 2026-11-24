import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

export interface CompactionApiRequestUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation1hTokens: number;
  observedAtMs: number;
}

export interface CompactionUsageWaitArgs {
  sessionId: string;
  sinceMs: number;
  timeoutMs: number;
}

export interface CompactionTelemetryReceiver {
  readonly env: Readonly<Record<string, string>>;
  readonly logsEndpoint: string;
  sessionEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string>;
  reaches(env: NodeJS.ProcessEnv | undefined): boolean;
  waitForCompactionUsage(
    args: CompactionUsageWaitArgs,
  ): Promise<CompactionApiRequestUsage | null>;
  close(): Promise<void>;
}

interface PendingCompactionUsageWait {
  sessionId: string;
  sinceMs: number;
  resolve: (usage: CompactionApiRequestUsage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OTLP_LOGS_PATH = "/v1/logs";

const MAX_OTLP_BODY_BYTES = 4 * 1024 * 1024;

const MAX_RETAINED_COMPACTION_USAGE = 32;

const API_REQUEST_EVENT_NAMES = new Set([
  "api_request",
  "claude_code.api_request",
]);

const COMPACT_QUERY_SOURCE = "compact";

const otlpAnyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const otlpAttributeSchema = z
  .object({ key: z.string(), value: otlpAnyValueSchema.optional() })
  .passthrough();

const otlpLogRecordSchema = z
  .object({
    timeUnixNano: z.union([z.string(), z.number()]).optional(),
    observedTimeUnixNano: z.union([z.string(), z.number()]).optional(),
    attributes: z.array(otlpAttributeSchema).optional(),
  })
  .passthrough();

const otlpLogsRequestSchema = z
  .object({
    resourceLogs: z
      .array(
        z
          .object({
            scopeLogs: z
              .array(
                z
                  .object({
                    logRecords: z.array(z.unknown()).optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

type OtlpAttribute = z.infer<typeof otlpAttributeSchema>;

function attributeText(
  attributes: readonly OtlpAttribute[],
  key: string,
): string | undefined {
  const value = attributes.find((attribute) => attribute.key === key)?.value;

  if (value === undefined) return undefined;

  if (value.stringValue !== undefined) return value.stringValue;

  if (value.intValue !== undefined) return String(value.intValue);

  if (value.doubleValue !== undefined) return String(value.doubleValue);

  return undefined;
}

function attributeTokenCount(
  attributes: readonly OtlpAttribute[],
  key: string,
): number {
  const text = attributeText(attributes, key)?.trim();

  if (text === undefined || text.length === 0) return 0;

  const parsed = Number(text);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function unixNanoToMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;

  try {
    const nanos = BigInt(value);

    return nanos > 0n ? Number(nanos / 1_000_000n) : undefined;
  } catch {
    return undefined;
  }
}

export function parseCompactionApiRequestUsage(
  body: unknown,
  receivedAtMs: number,
): CompactionApiRequestUsage[] {
  const parsed = otlpLogsRequestSchema.safeParse(body);

  if (!parsed.success) return [];

  const usages: CompactionApiRequestUsage[] = [];

  for (const resourceLog of parsed.data.resourceLogs ?? []) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const candidate of scopeLog.logRecords ?? []) {
        const record = otlpLogRecordSchema.safeParse(candidate);

        if (!record.success) continue;
        const attributes = record.data.attributes ?? [];
        const eventName = attributeText(attributes, "event.name");

        if (
          eventName === undefined ||
          !API_REQUEST_EVENT_NAMES.has(eventName) ||
          attributeText(attributes, "query_source") !== COMPACT_QUERY_SOURCE
        ) {
          continue;
        }

        const sessionId = attributeText(attributes, "session.id");

        if (sessionId === undefined || sessionId.length === 0) continue;

        usages.push({
          sessionId,
          inputTokens: attributeTokenCount(attributes, "input_tokens"),
          outputTokens: attributeTokenCount(attributes, "output_tokens"),
          cacheReadTokens: attributeTokenCount(attributes, "cache_read_tokens"),
          cacheCreationTokens: attributeTokenCount(
            attributes,
            "cache_creation_tokens",
          ),
          cacheCreation1hTokens: attributeTokenCount(
            attributes,
            "cache_creation_1h_tokens",
          ),
          observedAtMs:
            unixNanoToMs(record.data.timeUnixNano) ??
            unixNanoToMs(record.data.observedTimeUnixNano) ??
            receivedAtMs,
        });
      }
    }
  }

  return usages;
}

function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  if (header === undefined) return false;
  const actual = Buffer.from(header);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function respond(
  response: ServerResponse,
  status: number,
  body: string | null,
): void {
  response.writeHead(
    status,
    body === null ? {} : { "content-type": "application/json" },
  );
  response.end(body ?? undefined);
}

async function readBoundedBody(
  request: IncomingMessage,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;

    if (size > MAX_OTLP_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks);

  if (request.headers["content-encoding"] !== "gzip") {
    return body.toString("utf8");
  }

  return gunzipSync(body, { maxOutputLength: MAX_OTLP_BODY_BYTES }).toString(
    "utf8",
  );
}

export async function startCompactionTelemetryReceiver(
  options: { now?: () => number } = {},
): Promise<CompactionTelemetryReceiver> {
  const now = options.now ?? Date.now;
  const token = randomBytes(24).toString("hex");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const retained: CompactionApiRequestUsage[] = [];
  const waits = new Set<PendingCompactionUsageWait>();

  function matches(
    usage: CompactionApiRequestUsage,
    wait: { sessionId: string; sinceMs: number },
  ): boolean {
    return (
      usage.sessionId === wait.sessionId && usage.observedAtMs >= wait.sinceMs
    );
  }

  function deliver(usage: CompactionApiRequestUsage): void {
    for (const wait of waits) {
      if (!matches(usage, wait)) continue;
      waits.delete(wait);
      clearTimeout(wait.timer);
      wait.resolve(usage);

      return;
    }

    retained.push(usage);

    if (retained.length > MAX_RETAINED_COMPACTION_USAGE) retained.shift();
  }

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== OTLP_LOGS_PATH) {
      request.resume();
      respond(response, 404, null);

      return;
    }

    if (!bearerMatches(request.headers.authorization, expectedAuthorization)) {
      request.resume();
      respond(response, 401, null);

      return;
    }

    void readBoundedBody(request).then(
      (text) => {
        if (text === null) {
          respond(response, 413, null);

          return;
        }

        let body: unknown;

        try {
          body = JSON.parse(text);
        } catch {
          respond(response, 400, null);

          return;
        }

        for (const usage of parseCompactionApiRequestUsage(body, now())) {
          deliver(usage);
        }

        respond(response, 200, "{}");
      },
      () => {
        respond(response, 400, null);
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();

  const address = server.address();

  if (address === null || typeof address === "string") {
    server.close();

    throw new Error("Compaction telemetry receiver has no TCP address");
  }

  const logsEndpoint = `http://127.0.0.1:${address.port}${OTLP_LOGS_PATH}`;

  const env: Readonly<Record<string, string>> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsEndpoint,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };

  return {
    env,
    logsEndpoint,
    sessionEnv(hostEnv) {
      return hostEnv.OTEL_METRICS_EXPORTER === undefined
        ? { ...env, OTEL_METRICS_EXPORTER: "none" }
        : { ...env };
    },
    reaches(sessionEnv) {
      return Object.entries(env).every(
        ([key, value]) => sessionEnv?.[key] === value,
      );
    },
    waitForCompactionUsage(args) {
      const retainedIndex = retained.findIndex((usage) => matches(usage, args));

      if (retainedIndex !== -1) {
        const [usage] = retained.splice(retainedIndex, 1);

        return Promise.resolve(usage ?? null);
      }

      return new Promise((resolve) => {
        const wait: PendingCompactionUsageWait = {
          sessionId: args.sessionId,
          sinceMs: args.sinceMs,
          resolve,
          timer: setTimeout(() => {
            waits.delete(wait);
            resolve(null);
          }, args.timeoutMs),
        };

        wait.timer.unref();
        waits.add(wait);
      });
    },
    close() {
      for (const wait of waits) {
        clearTimeout(wait.timer);
        wait.resolve(null);
      }

      waits.clear();
      retained.length = 0;

      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
