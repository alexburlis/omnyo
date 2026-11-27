import { AbortError } from "p-retry";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { PendingInteractionCreate } from "@omnyo/domain";
import { hostDaemonSessionOpenRequestSchema } from "@omnyo/host-daemon-contract";
import { HOST_ARTIFACT_MAX_BYTES } from "@omnyo/host-daemon-contract/protocol";
import {
  createServerClient,
  readHostArtifactBytes,
  ServerResponseError,
  type FetchFn,
} from "./server-client.js";

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createInteractiveRequest(): PendingInteractionCreate {
  return {
    threadId: "thr_123",
    turnId: "turn_123",
    providerId: "codex",
    providerThreadId: "provider-thread-123",
    providerRequestId: "request-123",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-123",
        command: "git push",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

describe("createServerClient", () => {
  it.each([
    undefined,
    "event_lock;dur=1,event_tx;dur=2,event_after;dur=3",
    "malformed timing metadata",
  ])(
    "passes through optional event response timing without parsing: %s",
    async (serverTiming) => {
      const client = createServerClient({
        fetchFn: async () =>
          Response.json(
            { acceptedEvents: [], rejectedEvents: [], duplicateEvents: 0 },
            {
              headers:
                serverTiming === undefined
                  ? {}
                  : { "Server-Timing": serverTiming },
            },
          ),
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        serverUrl: "http://127.0.0.1:3334",
      });

      await expect(
        client.postEvents({ events: [], firstEventIndex: 1 }),
      ).resolves.toEqual({
        acceptedEvents: [],
        rejectedEvents: [],
        duplicateEvents: 0,
        ...(serverTiming === undefined ? {} : { serverTiming }),
      });
    },
  );

  it("narrows a protocol update retry request from error details", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json(
        {
          code: "protocol_version_mismatch",
          details: { retryUpdate: true },
          message: "protocol mismatch",
        },
        { status: 400 },
      ),
    );

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://omnyo.example.test",
    });

    const result = client.openSession({
      hostId: "host-1",
      hostName: "Host",
      dataDir: "/tmp/omnyo",
      instanceId: "instance-1",
      localApiPort: null,
      activeThreads: [],
      openThreadWork: [],

      undeliveredEventThreadIds: [],
      loadedEnvironments: [],
    });

    await expect(result).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      protocolUpdateRetryRequested: true,
    });
  });

  it.each([
    {
      server: "predates open-work sync",
      olderServerRequestSchema: hostDaemonSessionOpenRequestSchema.omit({
        openThreadWork: true,
      }),
      unsupportedFields: ["openThreadWork"],
    },
  ])(
    "opens a session on a server that $server without the fields it rejects",
    async ({ olderServerRequestSchema, unsupportedFields }) => {
      const bodies: Record<string, unknown>[] = [];

      const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
        const body = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(String(init?.body)));

        bodies.push(body);
        const parsed = olderServerRequestSchema.safeParse(body);

        if (!parsed.success) {
          return Response.json(
            {
              code: "invalid_request",
              message: parsed.error.issues[0]?.message ?? "Invalid request",
            },
            { status: 400 },
          );
        }

        return Response.json(
          {
            sessionId: "session-shipped-server",
            machineEnvironment: { revision: 0, entries: [] },
            diagnosticsPolicy: { revision: 0, crashReportsEnabled: false },
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
          },
          { status: 201 },
        );
      });

      const logger = createLogger();

      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger,
        serverUrl: "https://omnyo.example.test",
      });

      const session = await client.openSession({
        hostId: "host-1",
        hostName: "Host",
        dataDir: "/tmp/omnyo",
        instanceId: "instance-1",
        localApiPort: null,
        activeThreads: [],
        openThreadWork: [
          {
            threadId: "thr_123",
            backgroundItemIds: ["item_1"],
            interactiveRequests: [],
          },
        ],

        undeliveredEventThreadIds: [],
        loadedEnvironments: [],
      });

      expect(session).toMatchObject({
        sessionId: "session-shipped-server",
        endedInteractiveRequests: [],
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({
        openThreadWork: [{ threadId: "thr_123" }],
      });

      for (const field of ["openThreadWork"]) {
        if (unsupportedFields.includes(field)) {
          expect(bodies[1]).not.toHaveProperty(field);
        } else {
          expect(bodies[1]?.[field]).toEqual(bodies[0]?.[field]);
        }
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 400, unsupportedFields }),
        "Server predates optional session-open fields; opening the session without them",
      );
    },
  );

  it.each([
    'Unrecognized key: "extra"',
    'Unrecognized keys: "openThreadWork", "extra"',
  ])(
    "does not retry a session open the server rejects with %s",
    async (message) => {
      const fetchFn = vi.fn<FetchFn>(async () =>
        Response.json({ code: "invalid_request", message }, { status: 400 }),
      );

      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        serverUrl: "https://omnyo.example.test",
      });

      await expect(
        client.openSession({
          hostId: "host-1",
          hostName: "Host",
          dataDir: "/tmp/omnyo",
          instanceId: "instance-1",
          localApiPort: null,
          activeThreads: [],
          openThreadWork: [],

          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "with headers",
      details: {
        serverUrl: "https://studio.example.test",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
        headers: { "x-omnyo-connect-machine": "bbcm_new" },
      },
      expected: {
        serverUrl: "https://studio.example.test",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
        headers: { "x-omnyo-connect-machine": "bbcm_new" },
      },
    },
    {
      name: "from the moved responder",
      details: {
        serverUrl: "http://192.168.1.20:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
      expected: {
        serverUrl: "http://192.168.1.20:38886",
        toHostName: "studio",
        movedAt: 1_700_000_000_000,
      },
    },
    {
      name: "without a server URL",
      details: { toHostName: "studio", movedAt: 1_700_000_000_000 },
      expected: null,
    },
  ])(
    "preserves 410 server_moved details $name",
    async ({ details, expected }) => {
      const fetchFn = vi.fn<FetchFn>(async () =>
        Response.json(
          {
            code: "server_moved",
            message: "This Omnyo server moved to studio",
            details,
          },
          { status: 410 },
        ),
      );

      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        serverUrl: "http://old-server.example.test:38886",
      });

      await expect(
        client.openSession({
          hostId: "host-1",
          hostName: "Host",
          dataDir: "/tmp/omnyo",
          instanceId: "instance-1",
          localApiPort: null,
          activeThreads: [],
          openThreadWork: [],

          undeliveredEventThreadIds: [],
          loadedEnvironments: [],
        }),
      ).rejects.toMatchObject({
        status: 410,
        code: "server_moved",
        retryable: false,
        serverMoved: expected,
      });
    },
  );

  it.each([
    {
      serverHeaders: { "x-omnyo-connect-machine": "bbcm_machine" },
      hasMachineCredential: true,
    },
    { serverHeaders: undefined, hasMachineCredential: false },
  ])(
    "reports live machine-credential capability as $hasMachineCredential",
    async ({ serverHeaders, hasMachineCredential }) => {
      const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          hasMachineCredential,
          localApiPort: 38_888,
        });

        return Response.json(
          {
            sessionId: "session-1",
            machineEnvironment: { revision: 0, entries: [] },
            diagnosticsPolicy: { revision: 0, crashReportsEnabled: false },
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
            endedInteractiveRequests: [],
          },
          { status: 201 },
        );
      });

      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        ...(serverHeaders !== undefined ? { serverHeaders } : {}),
        serverUrl: "https://omnyo.example.test",
      });

      await client.openSession({
        hostId: "host-1",
        hostName: "Host",
        dataDir: "/tmp/omnyo",
        instanceId: "instance-1",
        localApiPort: 38_888,
        activeThreads: [],
        openThreadWork: [],

        undeliveredEventThreadIds: [],
        loadedEnvironments: [],
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("refuses to fetch project attachments over insecure non-loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>();

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://omnyo.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to fetch project attachments when the server URL is malformed", async () => {
    const fetchFn = vi.fn<FetchFn>();

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "not a url",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches project attachment bytes over HTTPS", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");
      expect(url.searchParams.get("sessionId")).toBe("session-1");
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      expect(url.searchParams.get("projectId")).toBe("project-1");
      expect(url.searchParams.get("path")).toBe("network-tab.har");

      return new Response("attachment-body", {
        headers: {
          "content-type": "application/octet-stream",
        },
        status: 200,
      });
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://omnyo.example.test",
    });

    const attachment = await client.fetchProjectAttachment({
      expectedSizeBytes: 15,
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe(
      "attachment-body",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetches and parses a skill tree over authenticated LAN HTTP", async () => {
    const treeHash = "a".repeat(64);

    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/internal/skills/tree/${treeHash}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-key",
      );
      expect(
        new Headers(init?.headers).get("x-omnyo-connect-machine"),
      ).toBeNull();

      return new Response(
        JSON.stringify({
          treeHash,
          entries: [
            { path: "SKILL.md", mode: 0o644, contentBase64: "dHJlZQ==" },
          ],
        }),
        { status: 200 },
      );
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://192.168.1.10:3000",
    });

    await expect(client.fetchSkillTree(treeHash)).resolves.toEqual({
      treeHash,
      entries: [{ path: "SKILL.md", mode: 0o644, contentBase64: "dHJlZQ==" }],
    });
  });

  it("rejects oversized host artifacts before fetching them", async () => {
    const fetchFn = vi.fn<FetchFn>();

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://omnyo.example.test",
    });

    await expect(
      client.fetchPluginHostArtifact({
        pluginId: "fixture",
        digest: "a".repeat(64),
        expectedByteLength: HOST_ARTIFACT_MAX_BYTES + 1,
      }),
    ).rejects.toThrow(/exceeds the .* byte limit/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops a chunked host artifact response at the byte limit", async () => {
    const chunkBytes = 1024 * 1024;
    const maxBytes = chunkBytes * 2;
    let emittedChunks = 0;
    const cancel = vi.fn();

    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          emittedChunks += 1;
          controller.enqueue(new Uint8Array(chunkBytes));

          if (emittedChunks === 32) controller.close();
        },
        cancel,
      }),
      { status: 200 },
    );

    await expect(
      readHostArtifactBytes(response, maxBytes + chunkBytes * 2, maxBytes),
    ).rejects.toThrow(/exceeds the .* byte limit/u);
    expect(emittedChunks).toBeLessThan(32);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("adds the connect machine credential to internal HTTP requests", async () => {
    const treeHash = "b".repeat(64);

    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer host-key");
      expect(headers.get("x-omnyo-connect-machine")).toBe("bbcm_machine");

      return new Response(JSON.stringify({ treeHash, entries: [] }), {
        status: 200,
      });
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverHeaders: { "x-omnyo-connect-machine": "bbcm_machine" },
      serverUrl: "https://omnyo.example.test",
    });

    await client.fetchSkillTree(treeHash);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects project attachment responses with unexpected byte length", async () => {
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response("too-large", {
          status: 200,
        }),
    );

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://omnyo.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        expectedSizeBytes: 4,
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toThrow("Project attachment size mismatch");
  });

  it("fetches project attachment bytes over loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");

      return new Response("loopback-body", {
        status: 200,
      });
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://127.0.0.1:3334",
    });

    const attachment = await client.fetchProjectAttachment({
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe(
      "loopback-body",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns accepted event mappings when posting events", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      expect(String(input)).toContain("/internal/session/events");
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: "session-1",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "turn/started",
                threadId: "thr_123",
                providerThreadId: "provider-thread",
                scope: { kind: "turn", turnId: "turn-1" },
              },
            ],
          },
        ],
        firstEventIndex: 7,
      });

      return new Response(
        JSON.stringify({
          acceptedEvents: [
            {
              eventIndex: 0,
              sequence: 6,
              threadId: "thr_123",
            },
          ],
          rejectedEvents: [],
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://omnyo.example.test",
    });

    await expect(
      client.postEvents({
        events: [
          {
            threadId: "thr_123",
            event: {
              type: "turn/started",
              threadId: "thr_123",
              providerThreadId: "provider-thread",
              scope: { kind: "turn", turnId: "turn-1" },
            },
          },
        ],
        firstEventIndex: 7,
      }),
    ).resolves.toEqual({
      acceptedEvents: [
        {
          eventIndex: 0,
          sequence: 6,
          threadId: "thr_123",
        },
      ],
      rejectedEvents: [],
    });
  });

  it("retries retryable interactive request registration responses with the same events stamp", async () => {
    let calls = 0;

    const fetchFn = vi.fn<FetchFn>(async () => {
      calls += 1;

      if (calls === 1) {
        return new Response(
          JSON.stringify({
            code: "turn_start_not_ready",
            message:
              "Turn start has not been stored yet; retry interactive request registration",
            retryable: true,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        );
      }

      return new Response(
        JSON.stringify({
          outcome: "created",
          interactionId: "pint_123",
          status: "pending",
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });

    const logger = createLogger();

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://omnyo.example.test",
    });

    await expect(
      client.registerInteractiveRequest(createInteractiveRequest(), 5),
    ).resolves.toEqual({
      outcome: "created",
      interactionId: "pint_123",
      status: "pending",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      fetchFn.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).eventsThrough,
      ),
    ).toEqual([5, 5]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        retriesLeft: expect.any(Number),
      }),
      "interactive request registration failed, retrying",
    );
  });

  it("does not retry non-retryable 503 interactive request registration responses", async () => {
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response(
          JSON.stringify({
            code: "maintenance",
            message: "Registration is disabled for this session",
            retryable: false,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        ),
    );

    const logger = createLogger();

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://omnyo.example.test",
    });

    const result = client.registerInteractiveRequest(
      createInteractiveRequest(),
      0,
    );

    await expect(result).rejects.toBeInstanceOf(ServerResponseError);
    await expect(result).rejects.toMatchObject({
      code: "maintenance",
      retryable: false,
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("dynamic tool cancellation", () => {
  it("passes cancellation to the tool-call HTTP transport", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;

    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      transportSignal = init?.signal;

      return Response.json({ success: true, contentItems: [] });
    });

    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "key",
      logger: createLogger(),
      serverUrl: "http://localhost",
    });

    await client.callTool(
      {
        requestId: 1,
        threadId: "thread",
        providerThreadId: "provider-thread",
        turnId: "turn",
        callId: "call",
        tool: "question",
      },
      { eventsThrough: 3, signal: controller.signal },
    );
    controller.abort();
    expect(transportSignal?.aborted).toBe(true);
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("signal");
    expect(body).toMatchObject({ eventsThrough: 3 });
  });
});
