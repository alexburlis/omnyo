import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodexModelRejection } from "./model-compatibility.js";
import { parseCodexRequestBody } from "./request-body.js";
import {
  cleanupPools,
  HOUR,
  SOL,
  LUNA,
  rejectionMessage,
  eventStream,
  rejection,
  createPool,
} from "./fixtures/codex-model-pool.js";

afterEach(cleanupPools);

describe.each(["http", "event-stream"] as const)(
  "Codex plan-model rejection delivered as %s",
  (shape) => {
    it("retries the same request on a compatible account and remembers the incompatible plan", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      const response = await pool.request(SOL);

      expect(response.status).toBe(200);
      expect(response.body).toContain(`plus-account:${SOL}`);
      expect(response.body).not.toContain("response.failed");
      expect(response.body).not.toContain("not supported");
      expect(pool.attempts).toEqual([
        `free-account:${SOL}`,
        `plus-account:${SOL}`,
      ]);
      expect(await pool.incompatibleModels("free-account")).toEqual([
        { model: SOL, plan: "free", observedAt: pool.now() },
      ]);
      expect(await pool.incompatibleModels("plus-account")).toEqual([]);
      expect(await pool.listedIncompatibleModels("free-account")).toEqual([
        { model: SOL, plan: "free", observedAt: pool.now() },
      ]);
    });

    it("skips the incompatible account for that model only, including after a restart", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      await pool.request(SOL);

      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`plus-account:${SOL}`]);

      const luna = await pool.request(LUNA);
      expect(luna.status).toBe(200);
      expect(luna.body).toContain(`free-account:${LUNA}`);
      expect(pool.attempts).toEqual([`free-account:${LUNA}`]);

      await pool.restart();

      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`plus-account:${SOL}`]);
      expect((await pool.request(LUNA)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${LUNA}`]);
    });

    it("answers with the earliest compatible reset when no compatible account is ready", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        {
          name: "plus-account",
          plan: "plus",
          unsupported: [],
          exhaustedFor: 3 * HOUR,
        },
      ]);

      const resetAt = pool.now() + 3 * HOUR;
      const response = await pool.request(SOL);

      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
      expect(response.status).toBe(429);
      expect(response.retryAfter).toBe(String(3 * 60 * 60));
      expect(JSON.parse(response.body)).toEqual({
        error: expect.objectContaining({
          type: "usage_limit_reached",
          resets_at: resetAt / 1_000,
        }),
      });
      expect(await pool.hub().retryAvailability("codex", "other", SOL)).toEqual(
        { kind: "blocked", retryAt: resetAt },
      );
      expect(
        await pool.hub().retryAvailability("codex", "other", LUNA),
      ).toEqual({ kind: "ready" });
    });

    it("returns ChatGPT's rejection without locking out the pool when every enabled account rejects the model", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "go-account", plan: "go", unsupported: [SOL] },
      ]);

      const expectUpstreamRejection = (
        response: Awaited<ReturnType<typeof pool.request>>,
      ) => {
        expect(response.status).toBe(shape === "http" ? 400 : 200);
        expect(response.retryAfter).toBeNull();
        expect(response.body).toContain(rejectionMessage(SOL));
        expect(response.body).not.toContain("Account Pooler");
      };

      const first = await pool.request(SOL);

      expect(pool.attempts).toEqual([
        `free-account:${SOL}`,
        `go-account:${SOL}`,
      ]);
      expectUpstreamRejection(first);
      expect(await pool.incompatibleModels("free-account")).toEqual([
        { model: SOL, plan: "free", observedAt: pool.now() },
      ]);
      expect(await pool.incompatibleModels("go-account")).toEqual([]);

      const second = await pool.request(SOL);
      expect(pool.attempts).toEqual([`go-account:${SOL}`]);
      expectUpstreamRejection(second);
      expect(await pool.incompatibleModels("go-account")).toEqual([]);
      expect(await pool.hub().retryAvailability("codex", "other", SOL)).toEqual(
        { kind: "ready" },
      );
      expect((await pool.request(LUNA)).status).toBe(200);

      pool.allow("go-account", SOL);
      const third = await pool.request(SOL);
      expect(third.status).toBe(200);
      expect(third.body).toContain(`go-account:${SOL}`);
      expect(pool.attempts).toEqual([`go-account:${SOL}`]);
    });

    it("probes a marked account when every enabled account is marked, and clears the mark when the model works", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      await pool.request(SOL);
      await pool.disable("plus-account");

      const probe = await pool.request(SOL);
      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
      expect(probe.status).toBe(shape === "http" ? 400 : 200);
      expect(probe.body).toContain(rejectionMessage(SOL));
      expect(await pool.hub().retryAvailability("codex", "other", SOL)).toEqual(
        { kind: "ready" },
      );

      pool.allow("free-account", SOL);
      const recovered = await pool.request(SOL);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toContain(`free-account:${SOL}`);
      expect(await pool.incompatibleModels("free-account")).toEqual([]);
    });

    it("clears the mark when the plan changes", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      await pool.request(SOL);
      pool.setPlan("free-account", "plus");
      pool.allow("free-account", SOL);
      await pool.refresh("free-account");

      expect(await pool.incompatibleModels("free-account")).toEqual([]);
      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
    });

    it("clears the mark when the account signs in again", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      await pool.request(SOL);
      await pool.signInAgain("free-account");

      expect(await pool.incompatibleModels("free-account")).toEqual([]);
    });

    it("probes the account again once the mark expires", async () => {
      const pool = await createPool(shape, [
        { name: "free-account", plan: "free", unsupported: [SOL] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ]);

      await pool.request(SOL);
      pool.advance(25 * HOUR);
      pool.allow("free-account", SOL);

      expect(await pool.incompatibleModels("free-account")).toEqual([]);
      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
    });

    it("spends credits first on the account whose plan rejects other models", async () => {
      const pool = await createPool(shape, [
        {
          name: "free-account",
          plan: "free",
          unsupported: [SOL],
          exhaustedFor: 30 * 24 * HOUR,
          credits: true,
        },
        {
          name: "plus-account",
          plan: "plus",
          unsupported: [],
          exhaustedFor: 30 * 24 * HOUR,
          credits: true,
        },
      ]);

      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([
        `free-account:${SOL}`,
        `plus-account:${SOL}`,
      ]);

      await pool.disable("free-account");
      expect((await pool.request(LUNA)).status).toBe(200);
      expect(pool.attempts).toEqual([`plus-account:${LUNA}`]);
      await pool.enable("free-account");

      expect((await pool.request(LUNA)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${LUNA}`]);
      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`plus-account:${SOL}`]);
      expect((await pool.request(LUNA)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${LUNA}`]);

      pool.advance(25 * HOUR);

      expect((await pool.request(LUNA)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${LUNA}`]);
    });
  },
);

describe("Codex rejections that are not plan-model rejections", () => {
  const nonPlanRejections: ReadonlyArray<{
    name: string;
    response: () => Response;
    status: number;
  }> = [
    {
      name: "a validation error that echoes a client value",
      status: 400,
      response: () =>
        Response.json(
          {
            error: {
              code: "invalid_value",
              message:
                "Invalid value for 'text.format.name': 'model is not supported when using Codex with a ChatGPT account'",
            },
          },
          { status: 400 },
        ),
    },
    {
      name: "a bare model_not_found code",
      status: 404,
      response: () =>
        Response.json(
          {
            error: {
              code: "model_not_found",
              message: "Search is unavailable for this model.",
            },
          },
          { status: 404 },
        ),
    },
    {
      name: "a plan rejection that names another model",
      status: 400,
      response: () =>
        Response.json({ detail: rejectionMessage(LUNA) }, { status: 400 }),
    },
    {
      name: "a failed stream with a bare model_not_found code",
      status: 200,
      response: () =>
        eventStream([
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: "model_not_found", message: "Model unavailable." },
            },
          } as { type: string },
        ]),
    },
  ];

  it.each(nonPlanRejections)(
    "passes $name through without marking the account",
    async ({ response, status }) => {
      let rejecting = true;

      const pool = await createPool(
        "http",
        [
          { name: "free-account", plan: "free", unsupported: [] },
          { name: "plus-account", plan: "plus", unsupported: [] },
        ],
        ({ account }) =>
          rejecting && account === "free-account" ? response() : undefined,
      );

      const rejected = await pool.request(SOL);

      expect(rejected.status).toBe(status);
      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
      expect(await pool.incompatibleModels("free-account")).toEqual([]);

      rejecting = false;
      expect((await pool.request(SOL)).status).toBe(200);
      expect(pool.attempts).toEqual([`free-account:${SOL}`]);
    },
  );

  it("never inspects or records a plan rejection from a route other than Responses", async () => {
    const pool = await createPool(
      "http",
      [
        { name: "free-account", plan: "free", unsupported: [] },
        { name: "plus-account", plan: "plus", unsupported: [] },
      ],
      ({ route, model }) =>
        route === "/alpha/search"
          ? Response.json({ detail: rejectionMessage(model) }, { status: 400 })
          : undefined,
    );

    const search = await pool.request(SOL, "/v1/alpha/search");

    expect(search.status).toBe(400);
    expect(search.body).toContain(rejectionMessage(SOL));
    expect(pool.attempts).toEqual([`free-account:/alpha/search:${SOL}`]);
    expect(await pool.incompatibleModels("free-account")).toEqual([]);

    const responses = await pool.request(SOL);
    expect(responses.status).toBe(200);
    expect(pool.attempts).toEqual([`free-account:${SOL}`]);
  });
});

describe("Codex model rejection inspection", () => {
  const encoder = new TextEncoder();

  const created =
    'event: response.created\ndata: {"type":"response.created"}\n\n';

  const completed =
    'event: response.completed\ndata: {"type":"response.completed"}\n\n';

  it("passes an unrelated client error through unchanged", async () => {
    const body = JSON.stringify({ detail: "Unsupported parameter: tools" });

    const inspected = await inspectCodexModelRejection(
      new Response(body, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      SOL,
      new AbortController().signal,
    );

    expect(inspected.rejected).toBe(false);
    expect(inspected.response.status).toBe(400);
    expect(await inspected.response.text()).toBe(body);
  });

  it("releases an undecided stream after the inspection bound without losing bytes", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(encoder.encode(created));
      },
    });

    const inspected = await inspectCodexModelRejection(
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
      SOL,
      new AbortController().signal,
    );

    expect(inspected.rejected).toBe(false);
    source?.enqueue(encoder.encode(completed));
    source?.close();
    expect(await inspected.response.text()).toBe(created + completed);
  });

  it("cancels the upstream read when the request aborts during inspection", async () => {
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(created));
      },
      cancel() {
        cancelled = true;
      },
    });

    const abort = new AbortController();

    const inspection = inspectCodexModelRejection(
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
      SOL,
      abort.signal,
    );

    abort.abort();

    expect((await inspection).rejected).toBe(false);
    expect(cancelled).toBe(true);
  });
});

describe("Codex request model parsing", () => {
  const body = { model: SOL, input: "ok", prompt_cache_key: "cache-key" };

  it("reads the model from a plain body", () => {
    const parsed = parseCodexRequestBody(
      new TextEncoder().encode(JSON.stringify(body)),
      new Headers(),
    );

    expect(parsed.model).toBe(SOL);
    expect(parsed.affinityId).toBe("cache:cache-key");
  });

  it("reads the model from a zstd-compressed body", () => {
    const parsed = parseCodexRequestBody(
      zstdCompressSync(Buffer.from(JSON.stringify(body))),
      new Headers({ "content-encoding": "zstd" }),
    );

    expect(parsed.model).toBe(SOL);
    expect(parsed.affinityId).toBe("cache:cache-key");
  });

  it.each([
    ["an unreadable body", new TextEncoder().encode("not json"), "identity"],
    ["a malformed zstd body", Buffer.from("not zstd"), "zstd"],
    [
      "a body without a model",
      new TextEncoder().encode(JSON.stringify({ input: "ok" })),
      "identity",
    ],
  ])("reports no model for %s", (_name, value, encoding) => {
    expect(
      parseCodexRequestBody(
        value,
        new Headers({ "content-encoding": encoding }),
      ).model,
    ).toBeNull();
  });
});
