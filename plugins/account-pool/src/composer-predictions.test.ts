import {
  composerPredictionPrompt,
  type ComposerPredictionConfiguration,
} from "./prediction-contract.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeHostResponse,
} from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { createAccountPoolPlugin } from "./server.js";
import { statusSchema } from "./contracts.js";
import { AccountStore } from "./store.js";

const predict = "experimental_composer-predictions.v1.predict";

const cancel = "experimental_composer-predictions.v1.cancel";

const caller = {
  experimental_caller: {
    kind: "plugin" as const,
    pluginId: "omnyo--composer-predictions",
  },
};

const cleanups: Array<() => Promise<void>> = [];

const config: ComposerPredictionConfiguration = {
  is_enabled: true,
  prompt: "  Provider prompt.\n",
  prompt_version: "fixture-v1",
  prediction_reasoning_effort: "high",
  unsupported_models: ["unsupported-fixture"],
};

const predictionMessage = {
  role: "user",
  content: [
    {
      type: "input_text",
      text: composerPredictionPrompt(config),
    },
  ],
};

async function setup(
  args: {
    claudeContext?: "complete" | "missing" | "oversize";
    exhausted?: boolean;
    includedSecondAccount?: boolean;
    apiKey?: boolean;
    configEnabled?: boolean;
    running?: boolean;
    parent?: boolean;
    pending?: boolean;
    credits?: boolean;
    omitCredits?: boolean;
    unknownQuota?: boolean;
    stalledMetadata?: boolean;
    inputSuffix?: z.output<z.ZodJSONSchema>[];
    historyBytes?: number;
    hostPreparationMs?: number;
    responseHeaders?: HeadersInit;
    inferenceResponse?: (signal: AbortSignal | null) => Promise<Response>;
    usageResponse?: () => Promise<Response>;
    requestEncoding?: "zstd";
  } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "omnyo-pool-prediction-"));

  const upstream: Array<{
    url: string;
    account: string | null;
    body: string | null;
    contentEncoding: string | null;
    contentLength: string | null;
  }> = [];

  let clock = Date.now();
  const omitCredits = args.omitCredits === true;

  let pausedValidation:
    | { promise: Promise<void>; enter: () => void; release: () => void }
    | undefined;

  const source = {
    completionSeq: 9,
    machine: makeHostResponse({ id: "host_one", status: "connected" }),
    thread: {
      ...makeThreadResponse({
        id: "thr_one",
        providerId: args.claudeContext ? "claude-code" : "codex",
        status: args.running ? "active" : "idle",
      }),
      environment: { hostId: "host_one", path: "/source" },
    },
  };

  let releaseHost:
    | ((value: {
        text: string | null;
        promptVersion: string;
        archiveReadiness: { ready: boolean; reason: string };
      }) => void)
    | undefined;

  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: {
        list: async () => [{ id: "host_one", name: "One" }],
        get: async () => {
          const paused = pausedValidation;

          if (paused === undefined) return source.machine;
          paused.enter();

          return paused.promise.then(() => source.machine);
        },
      },
      system: {
        providerStates: async () => ({ providers: [] }),
        config: async () => ({ primaryHostId: "host_one" }),
      },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
      threads: {
        get: async () =>
          args.stalledMetadata ? new Promise(() => {}) : source.thread,
        events: {
          list: async (input: {
            types?: readonly string[];
            afterSeq?: string;
          }) => {
            if (input.types?.includes("client/turn/requested")) {
              if (args.claudeContext === "missing") return [];

              if (input.afterSeq !== "0") return [];

              return [
                {
                  seq: 1,
                  type: "client/turn/requested",
                  data: {
                    requestId: "accepted",
                    input: [
                      {
                        type: "text",
                        text:
                          args.claudeContext === "oversize"
                            ? "x".repeat(500001)
                            : "Ship the repair.",
                      },
                    ],
                  },
                },
                {
                  seq: 2,
                  type: "turn/input/accepted",
                  data: { clientRequestId: "accepted" },
                },
                {
                  seq: 3,
                  type: "client/turn/requested",
                  data: {
                    requestId: "rejected",
                    input: [
                      {
                        type: "text",
                        text: "This request was never accepted.",
                      },
                    ],
                  },
                },
                {
                  seq: 4,
                  type: "item/completed",
                  data: {
                    item: {
                      id: "response",
                      type: "agentMessage",
                      text: "The repair is built; live verification remains.",
                    },
                  },
                },
              ];
            }

            return [
              {
                type: "turn/completed",
                seq: source.completionSeq,
                data: {
                  status: "completed",
                  providerThreadId: "native_source",
                  providerCheckpointId: "native_turn",
                },
              },
            ];
          },
        },
      },
    },
    experimental_callHostRpc: async (call) => {
      const input = z
        .object({
          route: z.object({ baseUrl: z.string(), capability: z.string() }),
          configuration: z.object({
            prompt: z.string(),
            prompt_version: z.string(),
            is_enabled: z.boolean(),
            prediction_reasoning_effort: z.enum(["high"]),
          }),
        })
        .parse(call.input);

      expect(input.configuration.prompt).toBe(config.prompt);

      if (args.claudeContext) {
        const context = z
          .object({ conversationContext: z.string() })
          .parse(call.input).conversationContext;

        expect(JSON.parse(context)).toEqual([
          { seq: 1, role: "user", text: "Ship the repair." },
          {
            seq: 4,
            role: "assistant",
            text: "The repair is built; live verification remains.",
          },
        ]);
      }

      if (args.pending)
        return new Promise((resolve) => {
          releaseHost = resolve;
        });

      clock += args.hostPreparationMs ?? 0;

      const body = JSON.stringify({
        model: "gpt-6-sol",
        store: false,
        tools: [
          {
            type: "function",
            name: "omnyo_parent_tool",
            description: "Synthetic inherited Omnyo tool",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: "required",
        input: [
          ...(args.historyBytes === undefined
            ? []
            : [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: "x".repeat(args.historyBytes) },
                  ],
                },
              ]),
          predictionMessage,
          ...(args.inputSuffix ?? []),
        ],
        client_metadata: { thread_id: "native_child" },
      });

      const encodedBody =
        args.requestEncoding === "zstd" ? zstdCompressSync(body) : body;

      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: {
            "x-omnyo-composer-prediction-token": input.route.capability,
            "content-type": "application/json",
            ...(args.requestEncoding === undefined
              ? {}
              : {
                  "content-encoding": args.requestEncoding,
                  "content-length": String(Buffer.byteLength(encodedBody)),
                }),
          },
          body: encodedBody,
        },
      );

      expect(response.status).toBe(200);
      await response.text();

      return {
        text: "Run the checks.",
        promptVersion: "fixture-v1",
        archiveReadiness: { ready: false, reason: "Required checks remain." },
      };
    },
  });

  await createAccountPoolPlugin({
    now: () => clock,
    env: args.parent
      ? {
          OMNYO_ACCOUNT_POOL_PARENT_URL: "https://parent.example/pool",
          OMNYO_ACCOUNT_POOL_PARENT_TOKEN: "p".repeat(43),
        }
      : {},
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);

      const body = z
        .union([z.string(), z.instanceof(ArrayBuffer)])
        .nullish()
        .parse(init?.body);

      upstream.push({
        url: String(url),
        account: headers.get("chatgpt-account-id"),
        contentEncoding: headers.get("content-encoding"),
        contentLength: headers.get("content-length"),
        body:
          body instanceof ArrayBuffer
            ? new TextDecoder().decode(body)
            : (body ?? null),
      });

      if (String(url).includes("/wham/usage") && args.usageResponse)
        return args.usageResponse();

      if (String(url).includes("/wham/usage")) {
        if (args.unknownQuota) return Response.json({});

        const usage = {
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent:
                args.exhausted &&
                headers.get("chatgpt-account-id") !== "included-account"
                  ? 100
                  : 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        };

        return Response.json(
          omitCredits
            ? usage
            : {
                ...usage,
                credits: {
                  has_credits: args.exhausted === true || args.credits === true,
                  unlimited: false,
                  balance: "100",
                },
              },
        );
      }

      if (String(url).includes("/predictions/config"))
        return Response.json({
          ...config,
          is_enabled: args.configEnabled !== false,
        });

      if (args.inferenceResponse)
        return args.inferenceResponse(init?.signal ?? null);

      return new Response("fixture response", {
        headers: args.responseHeaders ?? {
          "x-codex-primary-used-percent": "12",
          "x-codex-primary-window-minutes": "300",
        },
      });
    },
  })(host.api);

  const accounts = new AccountStore(
    host.api.storage.kv,
    host.api.experimental_secrets,
  );

  const add = async (label: string, identity: string, priority: number) => {
    const account = await accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label,
        email: null,
        accountUuid: null,
        codexAccountId: identity,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority,
      },
      {
        kind: "oauth",
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3600000,
      },
    );

    await host.harness.behavior.callRpc("account.enable", { id: account.id });
  };

  if (args.apiKey)
    await expect(
      host.harness.behavior.callRpc("account.add", {
        provider: "codex",
        apiKey: "fixture-key",
        label: "fixture",
        priority: 100,
      }),
    ).rejects.toThrow();
  else await add("fixture", "subscription-account", 100);

  if (args.includedSecondAccount)
    await add("included", "included-account", 200);
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () =>
    expect(
      z
        .object({ accepting: z.boolean() })
        .parse(await host.harness.behavior.callRpc("status.get", null))
        .accepting,
    ).toBe(true),
  );

  if (!args.apiKey && !args.unknownQuota)
    await vi.waitFor(async () => {
      const status = z
        .object({
          accounts: z.array(z.object({ observedAt: z.number().nullable() })),
        })
        .parse(await host.harness.behavior.callRpc("status.get", null));

      expect(status.accounts[0]?.observedAt).not.toBeNull();
    });
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  const request = (includedOnly = false) =>
    host.harness.behavior.callRpc(
      predict,
      { threadId: "thr_one", requestId: "request_one", includedOnly },
      caller,
    );

  return {
    host,
    upstream,
    source,
    routeResponse: async () => {
      const entries = await host.harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_one",
        projectId: "project_one",
        hostId: "host_one",
      });

      const token = z
        .string()
        .parse(
          entries.find((entry) => entry.name === "CODEX_POOL_AUTH_TOKEN")
            ?.value,
        );

      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: { "x-omnyo-account-pool-token": token },
          body: JSON.stringify({
            model: "gpt-6-sol",
            input: "Fixture source turn",
          }),
        },
      );

      expect(response.status).toBe(200);
      await response.text();
    },
    pauseSourceValidation: () => {
      let enter = () => {};

      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });

      let release = () => {};

      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });

      pausedValidation = { promise, enter, release };

      return {
        entered,
        release: () => {
          pausedValidation = undefined;
          release();
        },
      };
    },
    ageQuota: () => {
      clock += 61000;
    },
    request,
    release: () =>
      releaseHost?.({
        text: "Late result",
        promptVersion: "fixture-v1",
        archiveReadiness: { ready: false, reason: "Required checks remain." },
      }),
  };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("Account Pool composer prediction capability", () => {
  for (const { name, delayMs, expected } of [
    {
      name: "keeps an admitted prediction alive for forty seconds of inference",
      delayMs: 40000,
      expected: {
        inferenceStatus: 200,
        retryStatus: 409,
        upstreamAborted: false,
      },
    },
    {
      name: "expires an admitted prediction at the operation deadline",
      delayMs: 166000,
      expected: {
        inferenceStatus: 499,
        retryStatus: 401,
        upstreamAborted: true,
      },
    },
  ]) {
    it(name, async () => {
      let entered = () => {};

      const admitted = new Promise<void>((resolve) => {
        entered = resolve;
      });

      let releaseInference: (() => void) | undefined;
      const inferenceSignals: AbortSignal[] = [];

      const test = await setup({
        pending: true,
        inferenceResponse: async (signal) => {
          if (signal === null) throw new Error("Inference signal is missing");
          inferenceSignals.push(signal);
          entered();

          return new Promise<Response>((resolve, reject) => {
            releaseInference = () => resolve(new Response("fixture response"));
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      });

      vi.useFakeTimers();
      const pending = test.request();
      void pending.catch(() => {});

      try {
        await vi.waitFor(() =>
          expect(
            test.host.harness.inspection.experimental_hostRpcCalls,
          ).toHaveLength(1),
        );

        const input = z
          .object({ route: z.object({ capability: z.string() }) })
          .parse(
            test.host.harness.inspection.experimental_hostRpcCalls[0]?.input,
          );

        const headers = {
          "x-omnyo-composer-prediction-token": input.route.capability,
        };

        const response = test.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          {
            headers,
            body: JSON.stringify({
              model: "gpt-6-sol",
              store: false,
              tools: [],
              input: [predictionMessage],
            }),
          },
        );

        await admitted;
        await vi.advanceTimersByTimeAsync(delayMs);
        releaseInference?.();
        const completed = await response;

        const retry = await test.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          { headers, body: "{}" },
        );

        const observed = {
          inferenceStatus: completed.status,
          retryStatus: retry.status,
          upstreamAborted: inferenceSignals[0]?.aborted,
        };

        await completed.text();
        await retry.text();
        expect(observed, JSON.stringify(observed)).toEqual(expected);
      } finally {
        releaseInference?.();
        await test.host.harness.behavior.callRpc(
          cancel,
          { threadId: "thr_one", requestId: "request_one" },
          caller,
        );
        test.release();
        await pending.catch(() => {});
        vi.useRealTimers();
      }
    });
  }

  it("keeps prediction authorization valid during forty seconds of native setup", async () => {
    const test = await setup({ hostPreparationMs: 40000 });

    expect(await test.request()).toMatchObject({
      text: "Run the checks.",
      archiveReadiness: { ready: false },
    });
    expect(
      test.upstream.filter((call) => call.url.endsWith("/responses")),
    ).toHaveLength(1);
  });

  it("predicts Claude context through the same protected included-only capability", async () => {
    const test = await setup({ claudeContext: "complete" });
    expect(await test.request()).toMatchObject({
      text: "Run the checks.",
      archiveReadiness: { ready: false },
    });
  });

  it.each(["missing", "oversize"] as const)(
    "fails visibly for %s Claude context before inference",
    async (claudeContext) => {
      const test = await setup({ claudeContext });
      test.upstream.length = 0;
      await expect(test.request()).rejects.toThrow(
        "The Claude Code conversation context is unavailable or too large.",
      );
      expect(
        test.upstream.some(
          (call) =>
            call.url.includes("/predictions/config") ||
            call.url.endsWith("/responses"),
        ),
      ).toBe(false);
    },
  );

  it("never uses opted-in prepaid credits for Claude context", async () => {
    const test = await setup({ claudeContext: "complete", exhausted: true });
    await test.host.harness.behavior.callRpc("config.set", {
      composerPredictionAllowance: "included-or-prepaid-credits",
    });
    test.upstream.length = 0;
    await expect(test.request()).rejects.toThrow(
      "fresh included Codex allowance",
    );
    expect(test.upstream.some((call) => call.url.endsWith("/responses"))).toBe(
      false,
    );
  });

  it.each([false, true])(
    "keeps background predictions on included allowance with a second included account=%s",
    async (includedSecondAccount) => {
      const test = await setup({ exhausted: true, includedSecondAccount });
      await test.host.harness.behavior.callRpc("config.set", {
        composerPredictionAllowance: "included-or-prepaid-credits",
      });
      test.upstream.length = 0;

      if (includedSecondAccount) {
        expect(await test.request(true)).toMatchObject({
          text: "Run the checks.",
        });
        expect(
          test.upstream
            .filter((call) => call.url.endsWith("/responses"))
            .map((call) => call.account),
        ).toEqual(["included-account"]);
      } else {
        await expect(test.request(true)).rejects.toThrow(
          "fresh included Codex allowance",
        );
        expect(
          test.upstream.some(
            (call) =>
              call.url.endsWith("/predictions/config") ||
              call.url.endsWith("/responses"),
          ),
        ).toBe(false);
      }
    },
  );

  it("uses finite prepaid credits only after explicit opt-in", async () => {
    const test = await setup({ exhausted: true });
    await expect(test.request()).rejects.toThrow(
      "fresh included Codex allowance",
    );
    await test.host.harness.behavior.callRpc("config.set", {
      composerPredictionAllowance: "included-or-prepaid-credits",
    });
    test.upstream.length = 0;
    expect(await test.request()).toEqual({
      text: "Run the checks.",
      noSuggestionReason: null,
      promptVersion: "fixture-v1",
      archiveReadiness: {
        ready: false,
        reason: "Required checks remain.",
        waitingOn: null,
        ask: null,
        recap: null,
      },
    });
    expect(
      test.upstream
        .filter(
          (call) =>
            call.url.endsWith("/predictions/config") ||
            call.url.endsWith("/responses"),
        )
        .map((call) => call.account),
    ).toEqual(["subscription-account", "subscription-account"]);
  });

  it("prefers included allowance over a higher-priority prepaid account", async () => {
    const test = await setup({ exhausted: true, includedSecondAccount: true });
    await test.host.harness.behavior.callRpc("config.set", {
      composerPredictionAllowance: "included-or-prepaid-credits",
    });
    test.upstream.length = 0;
    expect(await test.request()).toMatchObject({ text: "Run the checks." });
    expect(
      test.upstream
        .filter(
          (call) =>
            call.url.endsWith("/predictions/config") ||
            call.url.endsWith("/responses"),
        )
        .map((call) => call.account),
    ).toEqual(["included-account", "included-account"]);
  });

  it("refuses stale prepaid credit metadata when allowance usage is refreshed", async () => {
    let includeCredits = true;

    const test = await setup({
      usageResponse: async () =>
        Response.json({
          ...(includeCredits
            ? { credits: { has_credits: true, unlimited: false } }
            : {}),
          rate_limit: {
            primary_window: { used_percent: 100, reset_after_seconds: 3600 },
          },
        }),
    });

    await test.host.harness.behavior.callRpc("config.set", {
      composerPredictionAllowance: "included-or-prepaid-credits",
    });
    includeCredits = false;
    test.ageQuota();
    test.upstream.length = 0;
    await expect(test.request()).rejects.toThrow("finite prepaid credits");
    expect(
      test.upstream.some(
        (call) =>
          call.url.endsWith("/predictions/config") ||
          call.url.endsWith("/responses"),
      ),
    ).toBe(false);
  });

  it.each([
    { name: "missing", credits: undefined },
    { name: "unknown", credits: null },
    { name: "incomplete", credits: { has_credits: true } },
    { name: "depleted", credits: { has_credits: false, unlimited: false } },
    { name: "unlimited", credits: { has_credits: true, unlimited: true } },
    {
      name: "restricted",
      credits: { has_credits: true, unlimited: false },
      restricted: true,
    },
  ])("rejects $name credit-only eligibility after opt-in", async (row) => {
    const test = await setup({
      unknownQuota: true,
      usageResponse: async () =>
        Response.json({
          credits: row.credits,
          rate_limit: {
            primary_window: { used_percent: 100, reset_after_seconds: 3600 },
          },
          ...(row.restricted ? { spend_control: { reached: true } } : {}),
        }),
    });

    await test.host.harness.behavior.callRpc("config.set", {
      composerPredictionAllowance: "included-or-prepaid-credits",
    });
    test.upstream.length = 0;
    await expect(test.request()).rejects.toThrow("finite prepaid credits");
    expect(
      test.upstream.some(
        (call) =>
          call.url.endsWith("/predictions/config") ||
          call.url.endsWith("/responses"),
      ),
    ).toBe(false);
  });

  it.each([{}, { credits: true }, { omitCredits: true }])(
    "uses fresh included allowance observed in ordinary response headers %j",
    async (args: { credits?: boolean; omitCredits?: boolean }) => {
      const headers = new Headers({
        "x-codex-primary-used-percent": "13",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-after-seconds": "3600",
      });

      if (args.credits) {
        headers.set("x-codex-credits-has-credits", "true");
        headers.set("x-codex-credits-unlimited", "false");
      } else if (!args.omitCredits) {
        headers.set("x-codex-credits-has-credits", "false");
        headers.set("x-codex-credits-unlimited", "false");
      }

      const test = await setup({
        ...args,
        unknownQuota: true,
        responseHeaders: headers,
      });

      await test.routeResponse();
      test.upstream.length = 0;
      expect(await test.request()).toEqual({
        text: "Run the checks.",
        noSuggestionReason: null,
        promptVersion: "fixture-v1",
        archiveReadiness: {
          ready: false,
          reason: "Required checks remain.",
          waitingOn: null,
          ask: null,
          recap: null,
        },
      });
      expect(
        test.upstream.filter((call) => call.url.endsWith("/responses")),
      ).toHaveLength(1);
      expect(
        test.upstream.find((call) => call.url.endsWith("/responses"))?.account,
      ).toBe("subscription-account");
    },
  );

  it.each([
    { name: "missing usage", used: null, reset: "3600" },
    { name: "empty usage", used: "", reset: "3600" },
    { name: "nonfinite usage", used: "NaN", reset: "3600" },
    { name: "negative usage", used: "-1", reset: "3600" },
    { name: "threshold", used: "98", reset: "3600" },
    { name: "exhausted", used: "101", reset: "3600" },
    { name: "missing reset", used: "13", reset: null },
    { name: "expired reset", used: "13", reset: "-1" },
    { name: "explicit over limit", used: "13", reset: "3600", rejected: true },
    { name: "stale", used: "13", reset: "3600", stale: true },
  ])("refuses $name header quota without a paid fallback", async (row) => {
    const headers = new Headers({
      "x-codex-primary-window-minutes": "10080",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
    });

    if (row.used !== null)
      headers.set("x-codex-primary-used-percent", row.used);

    if (row.reset !== null)
      headers.set("x-codex-primary-reset-after-seconds", row.reset);

    if (row.rejected) headers.set("x-codex-primary-over-limit", "true");
    const test = await setup({ unknownQuota: true, responseHeaders: headers });
    await test.routeResponse();

    if (row.stale) test.ageQuota();
    test.upstream.length = 0;
    await expect(test.request()).rejects.toThrow(
      "fresh included Codex allowance",
    );
    expect(
      test.upstream.some(
        (call) =>
          call.url.endsWith("/predictions/config") ||
          call.url.endsWith("/responses"),
      ),
    ).toBe(false);
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      0,
    );
  });

  it.each([
    {
      payload: "credits",
      rejected: false,
      restricted: false,
      creditHeader: false,
    },
    {
      payload: "credits",
      rejected: false,
      restricted: false,
      creditHeader: true,
    },
    {
      payload: "allowance",
      rejected: false,
      restricted: false,
      creditHeader: false,
    },
    {
      payload: "allowance",
      rejected: true,
      restricted: false,
      creditHeader: false,
    },
    {
      payload: "allowance",
      rejected: false,
      restricted: true,
      creditHeader: false,
    },
  ])(
    "preserves newer header quota through an older concurrent API response %j",
    async ({ payload, rejected, restricted, creditHeader }) => {
      let entered = () => {};

      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });

      let release = () => {};

      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });

      let blocking = false;

      const headers = new Headers({
        "x-codex-primary-used-percent": "13",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-after-seconds": "3600",
        "x-codex-primary-over-limit": String(rejected),
      });

      if (restricted)
        headers.set(
          "x-codex-rate-limit-reached-type",
          "workspace_member_usage_limit_reached",
        );

      if (creditHeader) {
        headers.set("x-codex-credits-has-credits", "false");
        headers.set("x-codex-credits-unlimited", "false");
      }

      const test = await setup({
        unknownQuota: true,
        responseHeaders: headers,
        usageResponse: async () => {
          if (blocking) {
            entered();
            await pending;

            if (payload === "credits")
              return Response.json({
                credits: { has_credits: true, unlimited: false },
              });

            return Response.json({
              rate_limit_reached_type: null,
              spend_control: { reached: false },
              rate_limit: {
                allowed: true,
                limit_reached: false,
                primary_window: { used_percent: 10, reset_after_seconds: 3600 },
              },
            });
          }

          return Response.json({});
        },
      });

      blocking = true;

      const status = statusSchema.parse(
        await test.host.harness.behavior.callRpc("status.get", null),
      );

      const refreshing = test.host.harness.behavior.callRpc(
        "account.refreshUsage",
        { accountId: status.accounts[0]!.id },
      );

      await started;
      test.ageQuota();
      await test.routeResponse();
      release();
      await refreshing;
      blocking = false;

      const updated = statusSchema.parse(
        await test.host.harness.behavior.callRpc("status.get", null),
      );

      expect(updated.accounts[0]?.limitWindows[0]).toMatchObject({
        utilization: 0.13,
        source: "header",
        status: rejected ? "rejected" : "allowed",
      });

      if (payload === "credits")
        expect(updated.accounts[0]?.extraUsage?.status).toBe(
          creditHeader ? "rejected" : "allowed",
        );

      if (restricted)
        expect(updated.accounts[0]?.usageRestriction?.reason).toBe(
          "workspace_member_usage_limit_reached",
        );

      if (rejected || restricted)
        await expect(test.request()).rejects.toThrow(
          "fresh included Codex allowance",
        );
      else
        expect(await test.request()).toMatchObject({ text: "Run the checks." });
    },
  );

  it.each([true, false])(
    "rechecks stale included allowance while Codex streams (refresh succeeds: %s)",
    async (refreshSucceeds) => {
      let usageAvailable = true;
      let streaming = true;
      let finishResponse = () => {};

      const test = await setup({
        claudeContext: "complete",
        usageResponse: async () =>
          usageAvailable
            ? Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: 10,
                    reset_after_seconds: 3600,
                  },
                },
              })
            : new Response(null, { status: 503 }),
        inferenceResponse: async () => {
          if (!streaming) return new Response("fixture prediction");
          streaming = false;

          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                finishResponse = () => controller.close();
              },
            }),
          );
        },
      });

      const response = test.routeResponse();

      try {
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await test.host.harness.behavior.callRpc("status.get", null),
          );

          expect(status.accounts[0]?.inFlight).toBe(1);
        });
        test.ageQuota();
        usageAvailable = refreshSucceeds;
        test.upstream.length = 0;

        if (refreshSucceeds)
          expect(await test.request(true)).toMatchObject({
            text: "Run the checks.",
          });
        else {
          await expect(test.request(true)).rejects.toThrow(
            "fresh included Codex allowance",
          );
          expect(
            test.upstream.some(
              (call) =>
                call.url.endsWith("/predictions/config") ||
                call.url.endsWith("/responses"),
            ),
          ).toBe(false);
        }

        expect(
          test.upstream.some((call) => call.url.endsWith("/wham/usage")),
        ).toBe(true);
        expect(
          statusSchema.parse(
            await test.host.harness.behavior.callRpc("status.get", null),
          ).accounts[0]?.inFlight,
        ).toBe(1);
      } finally {
        finishResponse();
        await response;
      }
    },
  );

  it("preserves ordinary credit-enabled routing while refusing explicitly unavailable included allowance", async () => {
    const test = await setup({
      usageResponse: async () =>
        Response.json({
          credits: { has_credits: true, unlimited: false },
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: { used_percent: 13, reset_after_seconds: 3600 },
          },
        }),
    });

    await test.routeResponse();
    test.upstream.length = 0;
    await expect(test.request()).rejects.toThrow(
      "fresh included Codex allowance",
    );
    expect(
      test.upstream.some(
        (call) =>
          call.url.endsWith("/predictions/config") ||
          call.url.endsWith("/responses"),
      ),
    ).toBe(false);
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      0,
    );
  });

  it("rejects clients and other plugins before account/config/host work", async () => {
    const test = await setup();
    test.upstream.length = 0;

    for (const options of [
      undefined,
      { experimental_caller: { kind: "plugin" as const, pluginId: "other" } },
    ])
      await expect(
        test.host.harness.behavior.callRpc(
          predict,
          { threadId: "thr_one", requestId: "one" },
          options,
        ),
      ).rejects.toThrow("Composer predictions caller is not authorized");
    expect(test.upstream).toEqual([]);
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      0,
    );
  });
  it("rejects caller supplied native IDs or source paths", async () => {
    const test = await setup();
    await expect(
      test.host.harness.behavior.callRpc(
        predict,
        {
          threadId: "thr_one",
          requestId: "one",
          nativeThreadId: "other",
          cwd: "/other",
        },
        caller,
      ),
    ).rejects.toThrow();
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      0,
    );
  });
  it.each([
    {},
    { credits: true },
    { omitCredits: true },
    { requestEncoding: "zstd" as const },
    {
      inputSuffix: [
        { type: "configuration_update", reasoning: { effort: "high" } },
      ],
    },
  ])(
    "routes provider config and supported prediction input through the same included subscription account %j",
    async (args) => {
      const test = await setup(args);
      expect(await test.request()).toEqual({
        text: "Run the checks.",
        noSuggestionReason: null,
        promptVersion: "fixture-v1",
        archiveReadiness: {
          ready: false,
          reason: "Required checks remain.",
          waitingOn: null,
          ask: null,
          recap: null,
        },
      });

      const native =
        test.host.harness.inspection.experimental_hostRpcCalls.at(-1);

      expect(native).toMatchObject({
        hostId: "host_one",
        input: {
          nativeThreadId: "native_source",
          cwd: "/source",
          cliPath: "codex",
        },
      });
      expect(
        test.upstream.find((call) => call.url.endsWith("/predictions/config"))
          ?.account,
      ).toBe("subscription-account");
      expect(
        test.upstream.find((call) => call.url.endsWith("/responses"))?.account,
      ).toBe("subscription-account");

      const forwarded = JSON.parse(
        test.upstream.find((call) => call.url.endsWith("/responses"))?.body ??
          "null",
      );

      expect(
        test.upstream.find((call) => call.url.endsWith("/responses")),
      ).toMatchObject({ contentEncoding: null, contentLength: null });

      expect(forwarded).toMatchObject({
        store: false,
        tool_choice: "none",
        tools: [{ type: "function", name: "omnyo_parent_tool" }],
        client_metadata: { thread_id: "native_child" },
        input: [predictionMessage, ...(args.inputSuffix ?? [])],
      });

      const input = z
        .object({ route: z.object({ capability: z.string() }) })
        .parse(native?.input);

      expect(
        (
          await test.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
            headers: {
              "x-omnyo-composer-prediction-token": input.route.capability,
            },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    },
  );
  it("forwards a valid image-sized prediction history above eight MiB", async () => {
    const test = await setup({ historyBytes: 22 * 1024 * 1024 });
    expect(await test.request()).toMatchObject({ text: "Run the checks." });

    const forwarded = test.upstream.find((call) =>
      call.url.endsWith("/responses"),
    )?.body;

    expect(Buffer.byteLength(forwarded ?? "")).toBeGreaterThan(
      22 * 1024 * 1024,
    );
    expect(JSON.parse(forwarded!).tool_choice).toBe("none");
  });
  it.each([
    {
      name: "malformed zstd",
      encoding: "zstd",
      body: () => Buffer.from("Not a zstd frame"),
      status: 400,
      message: "Invalid prediction payload",
    },
    {
      name: "decoded size limit",
      encoding: "zstd",
      body: () => zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)),
      status: 413,
      message: "Prediction request is too large",
    },
    {
      name: "encoded size limit",
      encoding: "identity",
      body: () => Buffer.alloc(32 * 1024 * 1024 + 1, 32),
      status: 413,
      message: "Prediction request is too large",
    },
    {
      name: "unsupported encoding",
      encoding: "br",
      body: () => Buffer.from("{}"),
      status: 415,
      message: "Unsupported prediction request encoding",
    },
    {
      name: "compressed arbitrary prompt",
      encoding: "zstd",
      body: () =>
        zstdCompressSync(
          JSON.stringify({
            model: "gpt-6-sol",
            store: false,
            tools: [],
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: "Arbitrary request" }],
              },
            ],
          }),
        ),
      status: 400,
      message:
        "Prediction payload must use the provider prediction prompt and supported function declarations (reason=prompt)",
    },
    ...[
      { name: "stored response", change: { store: true }, reason: "request" },
      {
        name: "unsupported model",
        change: { model: "unsupported-fixture" },
        reason: "model",
      },
      {
        name: "unsupported tool declaration",
        change: { tools: [{ type: "custom", name: "untrusted" }] },
        reason: "tools",
      },
    ].map(({ name, change, reason }) => ({
      name,
      encoding: "identity",
      body: () =>
        Buffer.from(
          JSON.stringify({
            model: "gpt-6-sol",
            store: false,
            tools: [],
            input: [predictionMessage],
            ...change,
          }),
        ),
      status: 400,
      message: `Prediction payload must use the provider prediction prompt and supported function declarations (reason=${reason})`,
    })),
  ])("refuses $name before prediction inference", async (row) => {
    const test = await setup({ pending: true });
    const pending = test.request();
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );

    const input = z
      .object({ route: z.object({ capability: z.string() }) })
      .parse(test.host.harness.inspection.experimental_hostRpcCalls[0]?.input);

    const response = await test.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-omnyo-composer-prediction-token": input.route.capability,
          "content-encoding": row.encoding,
        },
        body: row.body(),
      },
    );

    expect(response.status).toBe(row.status);
    expect(await response.json()).toMatchObject({
      error: { message: row.message },
    });
    expect(test.upstream.some((call) => call.url.endsWith("/responses"))).toBe(
      false,
    );
    test.release();
    await pending;
  });
  it.each([
    { args: { exhausted: true }, error: "fresh included Codex allowance" },
    { args: { unknownQuota: true }, error: "fresh included Codex allowance" },
    { args: { apiKey: true }, error: "fresh included Codex allowance" },
    { args: { running: true }, error: "idle thread" },
    {
      args: { configEnabled: false },
      error: "not enabled composer predictions",
    },
    {
      args: { parent: true },
      error: "parent proxy predictions are unavailable",
    },
  ])(
    "refuses unsupported or unavailable subscription predictions $args before native inference",
    async ({ args, error }) => {
      const test = await setup(args);
      await expect(test.request()).rejects.toThrow(error);
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(0);
      expect(
        test.upstream.some((call) => call.url.endsWith("/responses")),
      ).toBe(false);
    },
  );
  it("deduplicates the same active request identity without canceling its first caller", async () => {
    const test = await setup({ pending: true });
    const first = test.request();
    const second = test.request();
    void first.catch(() => {});
    void second.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );
    test.release();
    expect(await first).toEqual(await second);
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      1,
    );
  });
  it.each([
    "included stale",
    "included exhausted",
    "prepaid stale",
    "prepaid opt-out",
    "prepaid depleted",
    "prepaid unlimited",
    "prepaid restricted",
    "prepaid disabled",
  ])("rechecks %s after source validation awaits", async (change) => {
    const prepaid = change.startsWith("prepaid");
    let includedExhausted = false;
    let hasCredits = true;
    let unlimited = false;
    let restricted = false;

    const test = await setup({
      pending: true,
      usageResponse: async () =>
        Response.json({
          credits: { has_credits: hasCredits, unlimited },
          rate_limit: {
            primary_window: {
              used_percent: prepaid || includedExhausted ? 100 : 10,
              reset_after_seconds: 3600,
            },
          },
          spend_control: { reached: restricted },
        }),
    });

    if (prepaid || change === "included exhausted")
      await test.host.harness.behavior.callRpc("config.set", {
        composerPredictionAllowance: "included-or-prepaid-credits",
      });
    const pending = test.request(change === "included exhausted");
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );

    const input = z
      .object({ route: z.object({ capability: z.string() }) })
      .parse(test.host.harness.inspection.experimental_hostRpcCalls[0]?.input);

    const paused = test.pauseSourceValidation();

    const response = test.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-omnyo-composer-prediction-token": input.route.capability,
        },
        body: JSON.stringify({
          model: "gpt-6-sol",
          store: false,
          tools: [],
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: composerPredictionPrompt(config),
                },
              ],
            },
          ],
        }),
      },
    );

    await paused.entered;

    if (change.endsWith("stale")) test.ageQuota();
    else if (change.endsWith("opt-out"))
      await test.host.harness.behavior.callRpc("config.set", {
        composerPredictionAllowance: "included-only",
      });
    else {
      const status = statusSchema.parse(
        await test.host.harness.behavior.callRpc("status.get", null),
      );

      const accountId = status.accounts[0]!.id;

      if (change.endsWith("disabled"))
        await test.host.harness.behavior.callRpc("account.disable", {
          id: accountId,
        });
      else {
        includedExhausted = change === "included exhausted";
        hasCredits = !change.endsWith("depleted");
        unlimited = change.endsWith("unlimited");
        restricted = change.endsWith("restricted");
        await test.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId,
        });
      }
    }

    paused.release();
    expect((await response).status).toBe(429);
    expect(test.upstream.some((call) => call.url.endsWith("/responses"))).toBe(
      false,
    );
    await test.host.harness.behavior.callRpc(
      cancel,
      { threadId: "thr_one", requestId: "request_one" },
      caller,
    );
    test.release();
    await expect(pending).rejects.toThrow();
  });
  it.each(["completion", "machine"])(
    "revalidates changed %s before owned Responses dispatch",
    async (change) => {
      const test = await setup({ pending: true });
      const pending = test.request();
      void pending.catch(() => {});
      await vi.waitFor(() =>
        expect(
          test.host.harness.inspection.experimental_hostRpcCalls,
        ).toHaveLength(1),
      );

      if (change === "completion") test.source.completionSeq = 10;
      else
        test.source.machine = makeHostResponse({
          id: "host_one",
          status: "disconnected",
        });

      const input = z
        .object({ route: z.object({ capability: z.string() }) })
        .parse(
          test.host.harness.inspection.experimental_hostRpcCalls[0]?.input,
        );

      const response = await test.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: {
            "x-omnyo-composer-prediction-token": input.route.capability,
          },
          body: JSON.stringify({
            model: "gpt-6-sol",
            store: false,
            tools: [],
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: composerPredictionPrompt(config),
                  },
                ],
              },
            ],
          }),
        },
      );

      expect(response.status).toBe(499);
      expect(
        test.upstream.some((call) => call.url.endsWith("/responses")),
      ).toBe(false);
      test.release();
      await expect(pending).rejects.toThrow();
    },
  );
  it.each([
    { event: "thread.idle", phase: "initializing" },
    { event: "experimental_thread.events", phase: "initializing" },
    { event: "thread.idle", phase: "inference" },
    { event: "experimental_thread.events", phase: "inference" },
  ] as const)(
    "keeps the completed source after $event while $phase",
    async ({ event, phase }) => {
      const test = await setup({ pending: true });

      const paused =
        phase === "initializing" ? test.pauseSourceValidation() : null;

      const pending = test.request();
      let failure: unknown;
      void pending.catch((error: unknown) => {
        failure = error;
      });

      try {
        if (paused) await paused.entered;
        else
          await vi.waitFor(() =>
            expect(
              test.host.harness.inspection.experimental_hostRpcCalls,
            ).toHaveLength(1),
          );

        if (event === "experimental_thread.events")
          await test.host.harness.behavior.emitThreadEvent(event, {
            thread: test.source.thread,
            sequence: test.source.completionSeq,
          });
        else
          await test.host.harness.behavior.emitThreadEvent(event, {
            thread: test.source.thread,
            lastAssistantText: null,
          });
        paused?.release();
        await vi.waitFor(() => {
          if (failure !== undefined) throw failure;
          expect(
            test.host.harness.inspection.experimental_hostRpcCalls,
          ).toHaveLength(1);
        });
        test.release();
        await expect(pending).resolves.toMatchObject({ text: "Late result" });
      } finally {
        paused?.release();
        test.release();
        await pending.catch(() => {});
      }
    },
  );
  it.each(["completion", "queued message"] as const)(
    "rejects a changed %s during prediction initialization",
    async (change) => {
      const test = await setup();
      const paused = test.pauseSourceValidation();
      const pending = test.request();
      void pending.catch(() => {});
      await paused.entered;

      if (change === "completion") test.source.completionSeq = 10;
      else test.source.thread.queuedMessageCount = 1;
      await test.host.harness.behavior.emitThreadEvent(
        "experimental_thread.events",
        { thread: test.source.thread, sequence: 10 },
      );
      paused.release();
      await expect(pending).rejects.toThrow();
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(0);
    },
  );
  it.each([
    "thread.idle",
    "experimental_thread.events",
    "experimental_host.deleted",
  ] as const)("revokes native work after %s", async (event) => {
    const test = await setup({ pending: true });
    const pending = test.request();
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );
    test.source.completionSeq = 10;

    if (event === "experimental_thread.events")
      await test.host.harness.behavior.emitThreadEvent(event, {
        thread: test.source.thread,
        sequence: 10,
      });
    else if (event === "thread.idle")
      await test.host.harness.behavior.emitThreadEvent(event, {
        thread: test.source.thread,
        lastAssistantText: null,
      });
    else
      await test.host.harness.behavior.emitThreadEvent(event, {
        host: test.source.machine,
      });
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls[0]?.signal
          ?.aborted,
      ).toBe(true),
    );
    test.release();
    await expect(pending).rejects.toThrow("Prediction canceled");
  });
  it.each(["explicit cancellation", "thread.active"] as const)(
    "handles %s while metadata never settles without waiting for the SDK",
    async (event) => {
      const test = await setup({ stalledMetadata: true });
      const pending = test.request();
      void pending.catch(() => {});
      await vi.waitFor(() =>
        expect(test.host.harness.sdk.callsTo("threads.get")).toHaveLength(1),
      );

      if (event === "explicit cancellation")
        await test.host.harness.behavior.callRpc(
          cancel,
          { threadId: "thr_one", requestId: "request_one" },
          caller,
        );
      else
        await test.host.harness.behavior.emitThreadEvent(event, {
          thread: { ...test.source.thread, status: "active" },
        });
      await expect(pending).rejects.toThrow("Prediction canceled");
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(0);
    },
  );
  it("remembers an early cancellation before request registration", async () => {
    const test = await setup();
    await test.host.harness.behavior.callRpc(
      cancel,
      { threadId: "thr_one", requestId: "request_one" },
      caller,
    );
    await expect(test.request()).rejects.toThrow("Prediction canceled");
    expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
      0,
    );
  });
  it.each([
    {
      model: "gpt-6-sol",
      store: true,
      input: [predictionMessage],
    },
    ...[
      [{ type: "configuration_update", reasoning: { effort: "low" } }],
      [
        {
          type: "configuration_update",
          reasoning: { effort: "high" },
          tools: [{ type: "image_generation" }],
        },
      ],
      [
        {
          type: "configuration_update",
          reasoning: { effort: "high", instructions: "Arbitrary request" },
        },
      ],
      [
        {
          role: "user",
          content: [{ type: "input_text", text: "Other prompt" }],
        },
        { type: "configuration_update", reasoning: { effort: "high" } },
      ],
      [
        {
          type: "function_call_output",
          call_id: "other",
          output: "Other input",
        },
      ],
      [{ type: "configuration_update", reasoning: null }],
    ].map((suffix) => ({
      model: "gpt-6-sol",
      store: false,
      input: [predictionMessage, ...suffix],
    })),
    {
      model: "gpt-6-sol",
      store: false,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Arbitrary request" }],
        },
      ],
      tools: [],
    },
    {
      model: "gpt-6-sol",
      store: false,
      input: [],
      tools: [{ type: "image_generation" }],
    },
  ])("rejects broader provider inference payloads %j", async (body) => {
    const test = await setup({ pending: true });
    const pending = test.request();
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );

    const input = z
      .object({ route: z.object({ capability: z.string() }) })
      .parse(test.host.harness.inspection.experimental_hostRpcCalls[0]?.input);

    const response = await test.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-omnyo-composer-prediction-token": input.route.capability,
        },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    expect(test.upstream.some((call) => call.url.endsWith("/responses"))).toBe(
      false,
    );
    await test.host.harness.behavior.callRpc(
      cancel,
      { threadId: "thr_one", requestId: "request_one" },
      caller,
    );
    test.release();
    await expect(pending).rejects.toThrow();
  });
  it("cancels the owned host operation, rejects late output and revokes its capability", async () => {
    const test = await setup({ pending: true });
    const pending = test.request();
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        test.host.harness.inspection.experimental_hostRpcCalls,
      ).toHaveLength(1),
    );
    const native = test.host.harness.inspection.experimental_hostRpcCalls[0];
    expect(
      await test.host.harness.behavior.callRpc(
        cancel,
        { threadId: "thr_one", requestId: "request_one" },
        caller,
      ),
    ).toEqual({ cancelled: true });
    expect(native?.signal?.aborted).toBe(true);
    test.release();
    await expect(pending).rejects.toThrow("Prediction canceled");

    const input = z
      .object({ route: z.object({ capability: z.string() }) })
      .parse(native?.input);

    expect(
      (
        await test.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
          headers: {
            "x-omnyo-composer-prediction-token": input.route.capability,
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });
});

it("authorizes canonical and version-one prediction callers without host work", async () => {
  const test = await setup();
  test.upstream.length = 0;

  for (const pluginId of ["omnyo--composer-predictions"]) {
    await expect(
      test.host.harness.behavior.callRpc(
        cancel,
        { threadId: "thr_one", requestId: "migration-caller" },
        { experimental_caller: { kind: "plugin", pluginId } },
      ),
    ).resolves.toEqual({ cancelled: false });
  }

  for (const pluginId of [
    "composer-predictions",
    "bb--composer-predictions",
    "omnyo--account-usage",
    "foreign",
  ]) {
    await expect(
      test.host.harness.behavior.callRpc(
        cancel,
        { threadId: "thr_one", requestId: "denied-caller" },
        { experimental_caller: { kind: "plugin", pluginId } },
      ),
    ).rejects.toThrow("Composer predictions caller is not authorized");
  }

  expect(test.upstream).toEqual([]);
  expect(test.host.harness.inspection.experimental_hostRpcCalls).toHaveLength(
    0,
  );
});

it("authorizes only migrated reset callers before any provider operation", async () => {
  const test = await setup();
  test.upstream.length = 0;
  const input = { accountId: "00000000-0000-4000-8000-000000000001" };
  const method = "experimental_codex-resets.v1.credits";

  for (const pluginId of ["omnyo--account-usage"]) {
    await expect(
      test.host.harness.behavior.callRpc(method, input, {
        experimental_caller: { kind: "plugin", pluginId },
      }),
    ).rejects.toThrow("Choose an enabled Codex OAuth account for resets.");
  }

  for (const pluginId of [
    "account-usage",
    "bb--account-usage",
    "omnyo--composer-predictions",
    "foreign",
  ]) {
    await expect(
      test.host.harness.behavior.callRpc(method, input, {
        experimental_caller: { kind: "plugin", pluginId },
      }),
    ).rejects.toThrow("Codex resets caller is not authorized");
  }

  expect(test.upstream).toEqual([]);
});
