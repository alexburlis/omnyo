import { CREDENTIAL_REDACTION_MARKER } from "@omnyo/domain";
import type { Envelope, ErrorEvent, Event, Transport } from "@sentry/core";
import { getClient, getCurrentScope, Scope } from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH } from "../src/diagnostics.js";
import {
  captureProcessError,
  createProcessErrorReportingOptions,
  initProcessErrorReporting,
  resolveProcessErrorReportingStatus,
  scrubErrorReportEvent,
  sendProcessBugReport,
  setProcessErrorReportingEnabled,
} from "../src/error-reporting.js";

const homeDir = "/home/omnyo-tester";

const fixtureDsn = "https://public@sentry.example.test/1";

const bearerFixture = "Bearer fixture-credential-value";

beforeEach(() => setProcessErrorReportingEnabled(true));

function createErrorEvent(overrides: Partial<ErrorEvent>): ErrorEvent {
  return { type: undefined, ...overrides };
}

function createRecordingTransport(envelopes: Envelope[]): () => Transport {
  return () => ({
    flush: () => Promise.resolve(true),
    send: (envelope) => {
      envelopes.push(envelope);

      return Promise.resolve({});
    },
  });
}

function readSentEvents(envelopes: readonly Envelope[]): Event[] {
  return envelopes.flatMap(([, items]) =>
    items.flatMap(([header, payload]) =>
      header.type === "event" ? [payload as Event] : [],
    ),
  );
}

describe("scrubErrorReportEvent", () => {
  it("allows only diagnostic fields and owned source locations", () => {
    const marker = "private-customer-draft";

    const event = scrubErrorReportEvent(
      createErrorEvent({
        message: marker,
        fingerprint: [marker],
        tags: { stage: "request", customer: marker },
        release: marker,
        exception: {
          values: [
            {
              type: marker,
              value: marker,
              module: marker,
              stacktrace: {
                frames: [
                  {
                    filename: `/home/someone/${marker}/report.ts`,
                    function: marker,
                    lineno: 1,
                  },
                  {
                    filename: "/opt/omnyo/server/dist/start-server.js",
                    function: "privateCustomerDraft73",
                    lineno: 42,
                    colno: 7,
                  },
                ],
              },
            },
          ],
        },
        debug_meta: {
          images: [
            {
              type: "sourcemap",
              code_file: "/opt/omnyo/server/dist/start-server.js",
              debug_id: "12345678-1234-4234-8234-123456789abc",
            },
          ],
        },
      }),
      homeDir,
    );

    expect(JSON.stringify(event)).not.toContain(marker);
    expect(JSON.stringify(event)).not.toContain("privateCustomerDraft73");
    expect(event.fingerprint).toBeUndefined();
    expect(event.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      {
        filename: "app:///server/dist/start-server.js",
        lineno: 42,
        colno: 7,
      },
    ]);
    expect(event.debug_meta?.images).toEqual([
      {
        type: "sourcemap",
        code_file: "app:///server/dist/start-server.js",
        debug_id: "12345678-1234-4234-8234-123456789abc",
      },
    ]);
  });

  it("redacts credentials and the home directory from exception text and frames", () => {
    const scrubbed = scrubErrorReportEvent(
      createErrorEvent({
        exception: {
          values: [
            {
              type: "Error",
              value: `request to ${homeDir}/projects/app failed with ${bearerFixture}`,
              stacktrace: {
                frames: [
                  {
                    abs_path: `${homeDir}/Library/omnyo/dist/start-server.js`,
                    filename: `${homeDir}/Library/omnyo/dist/start-server.js`,
                    function: "runServer",
                    lineno: 12,
                    pre_context: ["const secret = 1;"],
                    vars: { token: "fixture" },
                  },
                ],
              },
            },
          ],
        },
        message: `${bearerFixture} at ${homeDir}/notes.txt`,
      }),
      homeDir,
    );

    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain("fixture-credential-value");
    expect(serialized).not.toContain(homeDir);
    expect(scrubbed.exception?.values?.[0]?.value).toBe("Error");
    expect(scrubbed.message).toBeUndefined();
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      {
        filename: "app:///dist/start-server.js",
        lineno: 12,
      },
    ]);
  });

  it("drops request, user, extra, breadcrumbs, server name, modules and environment contexts", () => {
    const scrubbed = scrubErrorReportEvent(
      createErrorEvent({
        breadcrumbs: [{ message: "typed input" }],
        contexts: {
          app: { app_name: "omnyo" },
          runtime: { name: "node", version: "v22.0.0" },
          process: {
            argv: ["node", "--token=fixture"],
            env: { HOME: homeDir },
          },
        },
        extra: { prompt: "private prompt" },
        modules: { "left-pad": "1.0.0" },
        request: { url: "https://app.example.test/threads/123", headers: {} },
        server_name: "alex-macbook",
        transaction: "GET /threads/123",
        user: { id: "user-1", ip_address: "203.0.113.4" },
      }),
      homeDir,
    );

    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.modules).toBeUndefined();
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.contexts).toBeUndefined();
  });

  it("caps the reported cause chain and keeps the outermost error", () => {
    const values = Array.from({ length: 12 }, (_, index) => ({
      type: "Error",
      value: `cause ${index}`,
    }));

    const scrubbed = scrubErrorReportEvent(
      createErrorEvent({ exception: { values } }),
      homeDir,
    );

    const reported = scrubbed.exception?.values ?? [];

    expect(reported).toHaveLength(MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH);
    expect(reported.at(-1)?.value).toBe("Error");
  });
});

describe("process error reporting through the Sentry client", () => {
  it("scrubs SDK enrichment and attachments at the final transport boundary", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "1.0.67",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient(options);
    client.init();
    client.on("beforeSendEvent", (event) => {
      event.message = "private-draft-after-before-send";
      event.release = "private-build-name";
      event.tags = { private: "private-customer" };
      event.contexts = {
        diagnostic: {
          operation: "claude-model-confirmation",
          stage: "receive",
          failureClass: "sdk-rejected",
          outcome: "terminal",
          status: 9999,
          attempt: -1,
          durationMs: Infinity,
          operationId: "private-customer",
          prompt: "private-prompt",
        },
        private: { draft: "private-draft" },
      };
    });
    const scope = new Scope();
    scope.setClient(client);
    scope.addAttachment({
      filename: "private-file.txt",
      data: "private-file-content",
    });
    scope.captureException(new TypeError("private-error"));
    await client.flush(1_000);
    const events = readSentEvents(envelopes);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain("private-");
    expect(events[0]?.release).toBe("1.0.67");
    expect(events[0]?.contexts?.diagnostic).toEqual({
      operation: "claude-model-confirmation",
      stage: "receive",
      failureClass: "sdk-rejected",
      outcome: "terminal",
    });
    expect(envelopes[0]?.[1].map(([header]) => header.type)).toEqual(["event"]);
    expect(events[0]?.exception?.values?.[0]).toMatchObject({
      type: "TypeError",
      value: "Claude model confirmation failed: sdk-rejected",
    });
  });

  it("sends only scrubbed exception data with service identity tags", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "0.46.293+private.1",
        service: "host-daemon",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient({
      ...options,
      integrations: options.integrations.filter(
        (integration) => integration.name !== "FunctionToString",
      ),
    });

    client.init();

    const cause = new Error(`cannot read ${homeDir}/.omnyo/state.json`);

    const error = new Error(`provider failed: ${bearerFixture}`, { cause });

    const scope = new Scope();
    scope.update(options.initialScope);
    scope.setExtra("prompt", "private prompt");
    scope.setUser({ id: "user-1", ip_address: "203.0.113.4" });

    scope.setClient(client);
    scope.captureException(error);
    await client.flush(1_000);

    const [event] = readSentEvents(envelopes);
    const serialized = JSON.stringify(event);

    expect(readSentEvents(envelopes)).toHaveLength(1);
    expect(serialized).not.toContain("fixture-credential-value");
    expect(serialized).not.toContain(homeDir);
    expect(serialized).not.toContain("private prompt");
    expect(event?.user).toBeUndefined();
    expect(event?.extra).toBeUndefined();
    expect(event?.release).toBe("0.46.293+private.1");
    expect(event?.environment).toBe("production");
    expect(event?.tags).toMatchObject({
      arch: process.arch,
      platform: process.platform,
      service: "host-daemon",
    });
    expect(event?.exception?.values?.map((value) => value.value)).toEqual([
      "Error",
      "Error",
    ]);
  });

  it("captures bounded plugin transport evidence and discards arbitrary tags", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "0.46.293+private.1",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient({
      ...options,
      integrations: options.integrations.filter(
        (integration) => integration.name === "OmnyoErrorReportingBoundary",
      ),
    });

    client.init();
    getCurrentScope().setClient(client);

    try {
      captureProcessError(new Error("Expo push receipt failed: X"), {
        level: "error",
        stage: "plugin",
        tags: { plugin: "push-notifications", code: "X" },
        fingerprint: ["plugin", "push-notifications", "expo.receipt", "X"],
        diagnostic: {
          operation: "plugin",
          stage: "receive",
          failureClass: "connection",
          outcome: "terminal",
          attempt: 3,
          itemCount: 20,
          transportCode: "ECONNRESET",
        },
      });
      await client.flush(1_000);
    } finally {
      getCurrentScope().setClient(undefined);
    }

    const [event] = readSentEvents(envelopes);

    expect(event?.level).toBe("error");
    expect(event?.tags).toMatchObject({ service: "coordinator" });
    expect(event?.tags).not.toHaveProperty("plugin");
    expect(event?.contexts?.diagnostic).toEqual({
      operation: "plugin",
      stage: "receive",
      failureClass: "connection",
      outcome: "terminal",
      attempt: 3,
      itemCount: 20,
      transportCode: "ECONNRESET",
    });
    expect(event?.fingerprint).toEqual([
      "{{ default }}",
      "plugin",
      "connection",
    ]);
  });
});

describe("actionable diagnostic filtering", () => {
  it("drops explicitly recovered, cancelled and deferred failures while preserving terminal and fatal events", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "1.0.73",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient(options);
    client.init();
    getCurrentScope().setClient(client);

    const failure = new Error("same logical operation");

    try {
      for (const outcome of [
        "recovered",
        "cancelled",
        "deferred",
        "terminal",
      ] as const) {
        captureProcessError(failure, {
          level: "error",
          stage: "request",
          diagnostic: {
            operation: "request",
            stage: "complete",
            failureClass: "connection",
            outcome,
          },
        });
      }

      captureProcessError(new Error("fatal"), {
        level: "fatal",
        stage: "uncaught-exception",
        diagnostic: {
          operation: "request",
          stage: "complete",
          failureClass: "internal",
          outcome: "cancelled",
        },
      });
      await client.flush(1000);
    } finally {
      getCurrentScope().setClient(undefined);
    }

    expect(readSentEvents(envelopes).map((event) => event.level)).toEqual([
      "error",
      "fatal",
    ]);
  });

  it("keeps bounded timeline proof and strips private fault identifiers", () => {
    const diagnostic = {
      operation: "timeline-read",
      stage: "execute",
      failureClass: "internal",
      outcome: "terminal",
      reason: "missing-turn-start",
      source: "turn/completed",
      projectionEventCount: 4,
      projectionMessageCount: 2,
      projectionStartSequence: 20,
      projectionEndSequence: 30,
      failureSequence: 25,
      turnEventCount: 2,
      turnStartCount: 0,
      eventsOrdered: true,
      storedStart: "before-window",
      storedStartSequence: 10,
    };

    const event = scrubErrorReportEvent(
      createErrorEvent({
        contexts: {
          diagnostic: {
            ...diagnostic,
            threadId: "private-thread",
            turnId: "private-turn",
            message: "private content",
          },
        },
      }),
      homeDir,
    );

    expect(event.contexts?.diagnostic).toEqual(diagnostic);
    expect(JSON.stringify(event)).not.toContain("private");
  });
});

describe("process error reporting crash reports setting", () => {
  it("retires captures across withdrawal and regrant before asynchronous processing finishes", async () => {
    const envelopes: Envelope[] = [];
    const pending: (() => void)[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "1.0.67",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient({
      ...options,
      integrations: [
        ...options.integrations,
        {
          name: "DeferredFixture",
          processEvent: (event) =>
            new Promise<Event>((resolve) => pending.push(() => resolve(event))),
        },
      ],
    });

    client.init();
    const scope = new Scope();
    scope.setClient(client);
    scope.captureException(new Error("captured before withdrawal"));
    setProcessErrorReportingEnabled(false);
    scope.captureException(new Error("captured while refused"));
    setProcessErrorReportingEnabled(true);
    pending.splice(0).forEach((release) => release());
    await client.flush(1_000);
    expect(readSentEvents(envelopes)).toHaveLength(0);

    scope.captureException(new Error("captured after new grant"));
    pending.splice(0).forEach((release) => release());
    await client.flush(1_000);
    expect(readSentEvents(envelopes)).toHaveLength(1);
  });

  it("checks the generation again at transport admission and preserves permitted shutdown", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "1.0.67",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient(options);
    client.init();
    const scope = new Scope();
    scope.setClient(client);

    const stop = client.on("beforeSendEvent", () => {
      setProcessErrorReportingEnabled(false);
      setProcessErrorReportingEnabled(true);
    });

    scope.captureException(new Error("queued before withdrawal"));
    await client.flush(1_000);
    expect(readSentEvents(envelopes)).toHaveLength(0);
    stop();
    scope.captureException(new Error("permitted terminal failure"));
    await client.close(1_000);
    expect(readSentEvents(envelopes)).toHaveLength(1);
  });

  it("keeps overlapping operation context isolated and drops unbounded extra fields", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "1.0.67",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient(options);
    client.init();
    getCurrentScope().setClient(client);

    try {
      captureProcessError(new TypeError("private first prompt"), {
        eventId: "12345678123442348234123456789abc",
        level: "error",
        stage: "request",
        diagnostic: {
          operation: "provider-request",
          stage: "receive",
          failureClass: "rate-limit",
          outcome: "terminal",
          status: 429,
          operationId: "12345678-1234-4234-8234-123456789abc",
        },
      });
      captureProcessError(new Error("private second prompt"), {
        eventId: "invalid-event-id",
        level: "error",
        stage: "request",
        diagnostic: {
          operation: "voice-transcription",
          stage: "decode",
          failureClass: "empty-result",
          outcome: "terminal",
          attempt: 2,
          operationId: "22345678-1234-4234-8234-123456789abc",
        },
      });
      await client.flush(1_000);
    } finally {
      getCurrentScope().setClient(undefined);
    }

    const events = readSentEvents(envelopes);
    expect(events.map((event) => event.exception?.values?.[0]?.value)).toEqual([
      "Provider request failed: rate-limit",
      "Voice transcription failed: empty-result",
    ]);
    expect(events[0]?.event_id).toBe("12345678123442348234123456789abc");
    expect(events[1]?.event_id).toMatch(/^[a-f0-9]{32}$/u);
    expect(events.map((event) => event.contexts?.diagnostic)).toEqual([
      {
        operation: "provider-request",
        stage: "receive",
        failureClass: "rate-limit",
        outcome: "terminal",
        status: 429,
        operationId: "12345678-1234-4234-8234-123456789abc",
      },
      {
        operation: "voice-transcription",
        stage: "decode",
        failureClass: "empty-result",
        outcome: "terminal",
        attempt: 2,
        operationId: "22345678-1234-4234-8234-123456789abc",
      },
    ]);
    expect(JSON.stringify(envelopes)).not.toContain("private");
    expect(events.map((event) => event.fingerprint)).toEqual([
      ["{{ default }}", "provider-request", "rate-limit"],
      ["{{ default }}", "voice-transcription", "empty-result"],
    ]);
  });

  it("drops events while crash reports are off and sends again once they are on", async () => {
    const envelopes: Envelope[] = [];

    const options = createProcessErrorReportingOptions(
      {
        dsn: fixtureDsn,
        homeDir,
        nodeEnv: "production",
        release: "0.46.293+private.1",
        service: "coordinator",
      },
      createRecordingTransport(envelopes),
    );

    const client = new ServerRuntimeClient({
      ...options,
      integrations: options.integrations.filter(
        (integration) => integration.name === "OmnyoErrorReportingBoundary",
      ),
    });

    client.init();

    const scope = new Scope();
    scope.setClient(client);

    try {
      setProcessErrorReportingEnabled(false);
      scope.captureException(new Error("while off"));
      await client.flush(1_000);

      expect(readSentEvents(envelopes)).toHaveLength(0);

      setProcessErrorReportingEnabled(true);
      scope.captureException(new Error("while on"));
      await client.flush(1_000);

      expect(
        readSentEvents(envelopes).map(
          (event) => event.exception?.values?.[0]?.value,
        ),
      ).toEqual(["Error"]);
    } finally {
      setProcessErrorReportingEnabled(true);
    }
  });
});

function readSentFeedback(envelopes: readonly Envelope[]): Event[] {
  return envelopes.flatMap(([, items]) =>
    items.flatMap(([header, payload]) =>
      header.type === "feedback" ? [payload as Event] : [],
    ),
  );
}

function createStatusTransport(
  envelopes: Envelope[],
  statusCode: number | undefined,
): () => Transport {
  return () => ({
    flush: () => Promise.resolve(true),
    send: (envelope) => {
      envelopes.push(envelope);

      return Promise.resolve(statusCode === undefined ? {} : { statusCode });
    },
  });
}

function createBugReportScope(transport: () => Transport): Scope {
  const options = createProcessErrorReportingOptions(
    {
      dsn: fixtureDsn,
      homeDir,
      nodeEnv: "production",
      release: "0.46.293+private.1",
      service: "coordinator",
    },
    transport,
  );

  const client = new ServerRuntimeClient({
    ...options,
    serverName: "alex-macbook",
    integrations: options.integrations.filter(
      (integration) => integration.name !== "FunctionToString",
    ),
  });

  client.init();
  const scope = new Scope();
  scope.update(options.initialScope);
  scope.setExtra("prompt", "private prompt");
  scope.setUser({ id: "user-1", ip_address: "203.0.113.4" });
  scope.setClient(client);

  return scope;
}

describe("sendProcessBugReport", () => {
  it("sends one scrubbed feedback event with the release and linked error", async () => {
    const envelopes: Envelope[] = [];
    const scope = createBugReportScope(createStatusTransport(envelopes, 200));
    const associatedEventId = "0123456789abcdef0123456789abcdef";

    const result = await sendProcessBugReport(
      {
        message: `Sidebar froze after ${bearerFixture} in ${homeDir}/repo`,
        email: "person@example.test",
        associatedEventId,
      },
      { scope },
    );

    const [feedback] = readSentFeedback(envelopes);
    const serialized = JSON.stringify(feedback);

    expect(result.status).toBe("sent");
    expect(result).toEqual({
      status: "sent",
      reportId: feedback?.event_id,
    });
    expect(readSentFeedback(envelopes)).toHaveLength(1);
    expect(readSentEvents(envelopes)).toHaveLength(0);
    expect(serialized).not.toContain("fixture-credential-value");
    expect(serialized).not.toContain(homeDir);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("203.0.113.4");
    expect(feedback?.server_name).toBeUndefined();
    expect(feedback?.user).toBeUndefined();
    expect(feedback?.extra).toBeUndefined();
    expect(feedback?.release).toBe("0.46.293+private.1");
    expect(feedback?.tags).toMatchObject({ service: "coordinator" });
    expect(feedback?.contexts?.feedback).toEqual({
      message: `Sidebar froze after Bearer ${CREDENTIAL_REDACTION_MARKER} in ~/repo`,
      source: "omnyo-bug-report",
      contact_email: "person@example.test",
      associated_event_id: associatedEventId,
    });
  });

  it("reports a rejected send as failed instead of sent", async () => {
    const scope = createBugReportScope(createStatusTransport([], 429));

    await expect(
      sendProcessBugReport({ message: "It broke" }, { scope }),
    ).resolves.toEqual({ status: "failed", reason: "rejected" });
  });

  it("times out when the transport never answers", async () => {
    const scope = createBugReportScope(() => ({
      flush: () => Promise.resolve(true),
      send: () => new Promise(() => {}),
    }));

    await expect(
      sendProcessBugReport({ message: "It broke" }, { scope, timeoutMs: 20 }),
    ).resolves.toEqual({ status: "failed", reason: "timeout" });
  });

  it("sends nothing while crash reports are off or without a client", async () => {
    const envelopes: Envelope[] = [];
    const scope = createBugReportScope(createStatusTransport(envelopes, 200));

    try {
      setProcessErrorReportingEnabled(false);

      await expect(
        sendProcessBugReport({ message: "It broke" }, { scope }),
      ).resolves.toEqual({
        status: "unavailable",
        reason: "crash-reports-off",
      });
    } finally {
      setProcessErrorReportingEnabled(true);
    }

    await expect(
      sendProcessBugReport({ message: "It broke" }, { scope: new Scope() }),
    ).resolves.toEqual({ status: "unavailable", reason: "not-configured" });
    expect(envelopes).toHaveLength(0);
  });
});

describe("process error reporting gate", () => {
  const productionConfig = {
    dsn: fixtureDsn,
    nodeEnv: "production",
    release: "0.46.293+private.1",
  };

  it("enables only production runtime versions with a DSN", () => {
    expect(resolveProcessErrorReportingStatus(productionConfig)).toEqual({
      enabled: true,
    });
    expect(
      resolveProcessErrorReportingStatus({
        ...productionConfig,
        release: "0.0.0-dev",
      }),
    ).toEqual({ enabled: false, reason: "development-version" });
    expect(
      resolveProcessErrorReportingStatus({ ...productionConfig, dsn: "" }),
    ).toEqual({ enabled: false, reason: "missing-dsn" });
    expect(
      resolveProcessErrorReportingStatus({
        ...productionConfig,
        nodeEnv: "development",
      }),
    ).toEqual({ enabled: false, reason: "not-production" });
  });

  it("does not start a Sentry client for a development version or an empty DSN", () => {
    expect(
      initProcessErrorReporting({
        ...productionConfig,
        homeDir,
        release: "0.0.0-dev",
        service: "coordinator",
      }),
    ).toEqual({ enabled: false, reason: "development-version" });
    expect(
      initProcessErrorReporting({
        ...productionConfig,
        dsn: "",
        homeDir,
        service: "coordinator",
      }),
    ).toEqual({ enabled: false, reason: "missing-dsn" });
    expect(getClient()).toBeUndefined();
  });
});
