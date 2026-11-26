import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@omnyo/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_signature_1";

const autoAskSessionOptions = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

const autoDenySessionOptions = {
  ...autoAskSessionOptions,
  permissionEscalation: "deny",
} as const;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;

let workspaceDir: string;

let requestLogPath: string;

let scriptPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "omnyo-codex-signature-ws-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 991_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "signature-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("keeps the constructed session for a turn whose options carry no envVars", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      ...FULL_ACCESS_SESSION_OPTIONS,
      envVars: { PATH: "/usr/bin:/bin" },
    },
  });
  const started = await harness.waitForResponse(1);

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_signature2",
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: { ...FULL_ACCESS_SESSION_OPTIONS },
  });
  const turn = await harness.waitForResponse(2);

  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

it("passes contributed environment to Codex children without overriding their shell environment policy", async () => {
  vi.stubEnv("PATH", "/synthetic/trusted/bin");
  vi.stubEnv("HOME", "/synthetic/trusted/home");
  vi.stubEnv("NODE_OPTIONS", "--no-warnings");
  vi.stubEnv("OPENAI_API_KEY", "inherited");
  vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:1/trusted");

  vi.stubEnv("CODEX_TEST_CONTROL", "inherited");
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:2/trusted");
  vi.stubEnv("SSL_CERT_FILE", "/synthetic/trusted/certificate.pem");

  const processControls = {
    CODEX_TEST_CONTROL: "project",
    HTTPS_PROXY: "http://127.0.0.1:2/project",
    SSL_CERT_FILE: "/project/certificate.pem",
    PATH: "/project/bin",
    HOME: "/project/home",
    NODE_OPTIONS: "--invalid-project-loader",
    OPENAI_API_KEY: "project",
    OPENAI_BASE_URL: "http://127.0.0.1:1/project",
    OMNYO_CODEX_BRIDGE_APP_SERVER_COMMAND: "project-command",
    OMNYO_CODEX_BRIDGE_APP_SERVER_ARGS: "invalid-project-args",
  };

  const launchLogPath = join(workspaceDir, "launches.jsonl");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      requestLogPath,
      launchLogPath,
      captureTestEnvironment: true,
    }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      ...FULL_ACCESS_SESSION_OPTIONS,
      envVars: { ...processControls, PROJECT_FIXTURE_VALUE: "first" },
    },
  });
  const response = await harness.waitForResponse(1);
  expect(response.error).toBeUndefined();

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(response.result);

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_22222222aa",
    input: [{ type: "text", text: "Continue", mentions: [] }],
    options: {
      ...FULL_ACCESS_SESSION_OPTIONS,
      envVars: { ...processControls, PROJECT_FIXTURE_VALUE: "second" },
    },
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  const launches = readFileSync(launchLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          testEnvironment: z.object({
            PROJECT_FIXTURE_VALUE: z.string(),
            trustedProcessControls: z.record(z.string(), z.boolean()),
          }),
        })
        .parse(JSON.parse(line)),
    );

  expect(
    launches.map((launch) => launch.testEnvironment.PROJECT_FIXTURE_VALUE),
  ).toEqual(["first", "second"]);

  for (const launch of launches)
    expect(launch.testEnvironment.trustedProcessControls).toEqual({
      path: true,
      home: true,
      loader: true,
      providerIdentity: true,
      providerEndpoint: true,
      providerNamespace: true,
      proxy: true,
      tls: true,
      launchOverrideAbsent: true,
    });

  for (const request of recordedRequests().filter(
    (entry) =>
      entry.method === "thread/start" || entry.method === "thread/resume",
  )) {
    expect(request.params.config).not.toHaveProperty(
      "shell_environment_policy.set.PROJECT_FIXTURE_VALUE",
    );
  }
}, 30_000);

it("rebuilds the session only when a turn changes or removes an env var", async () => {
  const original = {
    OMNYO_TEST_SECRET: "original",
    OMNYO_TEST_REMOVED: "gone",
  };

  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS, envVars: original },
  });
  const started = await harness.waitForResponse(1);

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  const turnEnvVars: Record<string, string>[] = [
    { OMNYO_TEST_REMOVED: "gone", OMNYO_TEST_SECRET: "original" },
    { OMNYO_TEST_SECRET: "rotated", OMNYO_TEST_REMOVED: "gone" },
    { OMNYO_TEST_SECRET: "rotated" },
    { OMNYO_TEST_SECRET: "rotated" },
  ];

  const replacementsAfterTurn: number[] = [];

  for (const [index, envVars] of turnEnvVars.entries()) {
    const id = index + 2;
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: `creq_envswapxx${id}`,
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options: { ...FULL_ACCESS_SESSION_OPTIONS, envVars },
    });
    expect((await harness.waitForResponse(id)).error).toBeUndefined();
    replacementsAfterTurn.push(
      harness.messages.filter(
        (message) => message.method === "session/replaced",
      ).length,
    );
  }

  expect(replacementsAfterTurn).toEqual([0, 1, 2, 2]);

  const resumeConfigs = recordedRequests()
    .filter((request) => request.method === "thread/resume")
    .map((request) =>
      z
        .object({ config: z.record(z.string(), z.unknown()) })
        .parse(request.params),
    )
    .map(({ config }) =>
      Object.fromEntries(
        Object.entries(config).filter(([key]) =>
          key.startsWith("shell_environment_policy.set.OMNYO_TEST_"),
        ),
      ),
    );

  expect(resumeConfigs).toEqual([{}, {}]);
}, 30_000);

it("keeps an auto-reviewed session when only escalation intent changes", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: autoAskSessionOptions,
  });
  const started = await harness.waitForResponse(1);

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_signature3",
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: autoDenySessionOptions,
  });
  const turn = await harness.waitForResponse(2);

  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

function recordedRequests() {
  const schema = z.object({
    method: z.string(),
    params: z.looseObject({ serviceTier: z.string().nullable().optional() }),
  });

  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));
}

it("clears Fast for the next turn without replacing the session", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS, serviceTier: "fast" },
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  for (const [index, serviceTier] of ["fast", "default", "fast"].entries()) {
    const id = index + 2;
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: `creq_tiertestx${id}`,
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options: { ...FULL_ACCESS_SESSION_OPTIONS, serviceTier },
    });
    expect((await harness.waitForResponse(id)).error).toBeUndefined();
    expect(recordedRequests().at(-1)).toEqual({
      method: "turn/start",
      params: expect.objectContaining({
        serviceTier: serviceTier === "default" ? null : "fast",
      }),
    });
  }

  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

it.each(["start", "resume", "fork"] as const)(
  "sends an explicit default reset when constructing a %s session",
  async (kind) => {
    harness.sendRequest(1, `thread/${kind}`, {
      threadId: THREAD_ID,
      ...(kind === "resume" ? { providerThreadId: "provider-fast" } : {}),
      ...(kind === "fork" ? { sourceProviderThreadId: "provider-fast" } : {}),
      cwd: workspaceDir,
      instructionMode: "append",
      options: { ...FULL_ACCESS_SESSION_OPTIONS, serviceTier: "default" },
    });
    expect((await harness.waitForResponse(1)).error).toBeUndefined();
    expect(recordedRequests()).toContainEqual({
      method: `thread/${kind}`,
      params: expect.objectContaining({ serviceTier: null }),
    });
  },
  30_000,
);

it.each([
  {
    before: FULL_ACCESS_SESSION_OPTIONS,
    after: autoAskSessionOptions,
    sandbox: "workspaceWrite",
    beforeResponse: false,
    compaction: true,
  },
  {
    before: FULL_ACCESS_SESSION_OPTIONS,
    after: autoAskSessionOptions,
    sandbox: "workspaceWrite",
    beforeResponse: false,
    compaction: false,
  },
  {
    before: FULL_ACCESS_SESSION_OPTIONS,
    after: autoAskSessionOptions,
    sandbox: "workspaceWrite",
    beforeResponse: true,
    compaction: false,
  },
  {
    before: autoAskSessionOptions,
    after: FULL_ACCESS_SESSION_OPTIONS,
    sandbox: "dangerFullAccess",
    beforeResponse: false,
    compaction: false,
  },
])(
  "applies $sandbox before steering (start response pending: $beforeResponse, initial compaction: $compaction)",
  async ({ before, after, sandbox, beforeResponse, compaction }) => {
    if (compaction)
      vi.stubEnv("FAKE_CODEX_COMPACTION_MODE", "wait-for-interrupt");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        requestLogPath,
        startResponseDelayMs: beforeResponse ? 2000 : 0,
      }),
    );
    harness.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: before,
    });
    const started = await harness.waitForResponse(1);

    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(started.result);

    harness.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: "creq_permstart2",
      input: compaction
        ? [
            {
              type: "text",
              text: "/compact",
              mentions: [
                {
                  start: 0,
                  end: 8,
                  resource: {
                    kind: "command",
                    trigger: "/",
                    name: "compact",
                    source: "command",
                    origin: "builtin",
                    label: "compact",
                    argumentHint: null,
                  },
                },
              ],
            },
          ]
        : [{ type: "text", text: "/wait-for-interrupt", mentions: [] }],
      options: before,
    });

    if (!beforeResponse) {
      expect((await harness.waitForResponse(2)).error).toBeUndefined();
    }

    await vi.waitFor(() =>
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          method: "thread/delta",
          params: expect.objectContaining({
            deltas: expect.arrayContaining([
              expect.objectContaining({ kind: "turn.open" }),
            ]),
          }),
        }),
      ),
    );

    if (beforeResponse) {
      expect(harness.messages.some((message) => message.id === 2)).toBe(false);
    }

    harness.sendRequest(3, "turn/steer", {
      threadId: THREAD_ID,
      providerThreadId,
      expectedTurnId: "turn-fx-1",
      clientRequestId: "creq_permsteer2",
      input: [
        {
          type: "text",
          text: "Continue with the new permissions",
          mentions: [],
        },
      ],
      options: after,
    });
    expect((await harness.waitForResponse(3)).error).toBeUndefined();
    expect(
      harness.messages.filter(
        (message) => message.method === "session/replaced",
      ),
    ).toEqual([]);
    const requests = recordedRequests();
    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual(
      [],
    );
    expect(
      requests.filter((entry) => entry.method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(
      requests.filter((entry) => entry.method === "turn/start").at(-1)?.params,
    ).toMatchObject({
      threadId: providerThreadId,
      sandboxPolicy: { type: sandbox },
    });
  },
  30_000,
);

it("applies follow-up permission changes in both directions without replacing the app-server", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  const cases = [
    {
      options: autoAskSessionOptions,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspaceWrite",
    },
    {
      options: FULL_ACCESS_SESSION_OPTIONS,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "dangerFullAccess",
    },
    {
      options: {
        ...autoAskSessionOptions,
        permissionMode: "accept-edits",
        approvalReviewer: "user",
        permissionEscalation: "deny",
      },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspaceWrite",
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const id = index + 2;
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: `creq_permtestx${id}`,
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options: testCase.options,
    });
    expect((await harness.waitForResponse(id)).error).toBeUndefined();
    expect(recordedRequests().at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        approvalPolicy: testCase.approvalPolicy,
        approvalsReviewer: testCase.approvalsReviewer,
        sandboxPolicy: { type: testCase.sandbox },
      },
    });
  }

  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
  expect(
    recordedRequests().filter((request) => request.method === "initialize"),
  ).toHaveLength(1);
}, 30_000);

it.each([
  ["thread/start", true],
  ["thread/resume", true],
  ["thread/fork", true],
  ["thread/start", false],
  ["thread/resume", false],
  ["thread/fork", false],
] as const)(
  "pins %s to the canonical provider only for explicit pool routing (%s)",
  async (method, pooled) => {
    const originalNativeId = "opaque-source-bb-account-pool-v1";
    writeFileSync(
      scriptPath,
      JSON.stringify({
        requestLogPath,
        threadReadResults: {
          [originalNativeId]: {
            id: originalNativeId,
            modelProvider: "omnyo-account-pool",
          },
        },
      }),
    );
    harness.sendRequest(501, method, {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: {
        ...FULL_ACCESS_SESSION_OPTIONS,
        envVars: {
          CODEX_OPENAI_BASE_URL: pooled ? "http://127.0.0.1:1/v1" : "",
          CODEX_POOL_AUTH_TOKEN: pooled ? "synthetic-pool-token" : "",
        },
      },
      ...(method === "thread/resume"
        ? { providerThreadId: originalNativeId }
        : {}),
      ...(method === "thread/fork"
        ? { sourceProviderThreadId: originalNativeId }
        : {}),
    });
    const response = await harness.waitForResponse(501);
    expect(response.error).toBeUndefined();
    const requests = recordedRequests();
    expect(
      requests.find((request) => request.method === "initialize")?.params,
    ).toMatchObject({ clientInfo: { name: "omnyo" } });

    const construction = requests.filter(
      (request) => request.method === method,
    );

    expect(construction[0]?.params?.modelProvider).toBe(
      pooled ? "omnyo-account-pool" : undefined,
    );

    expect(construction).toHaveLength(1);

    if (pooled)
      expect(construction[0]?.params).toMatchObject({
        config: { model_provider: "omnyo-account-pool" },
      });
    else
      expect(construction[0]?.params).not.toHaveProperty(
        "config.model_provider",
      );

    if (method !== "thread/start")
      expect(construction[0]?.params).toHaveProperty(
        "threadId",
        originalNativeId,
      );
  },
);

const workspaceNetworkCases = [
  { name: "unset Codex network config", script: {}, networkAccess: true },
  {
    name: "Codex config turning network off",
    script: {
      configRead: {
        config: { sandbox_workspace_write: { network_access: false } },
        origins: {
          "sandbox_workspace_write.network_access": {
            name: { type: "user", file: "/home/user/.codex/config.toml" },
          },
        },
      },
    },
    networkAccess: false,
  },
  {
    name: "admin requirements managing only the network",
    script: {
      configRequirementsRead: { requirements: { network: { enabled: false } } },
    },
    networkAccess: false,
  },
];

it.each(workspaceNetworkCases)(
  "sends workspace turns the network access resolved from $name",
  async ({ script, networkAccess }) => {
    writeFileSync(scriptPath, JSON.stringify({ requestLogPath, ...script }));
    harness.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: autoAskSessionOptions,
    });
    const started = await harness.waitForResponse(1);
    expect(started.error).toBeUndefined();

    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(started.result);

    harness.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: "creq_netwrkaccs",
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options: autoAskSessionOptions,
    });
    expect((await harness.waitForResponse(2)).error).toBeUndefined();

    const requests = recordedRequests();
    expect(
      requests.find((entry) => entry.method === "config/read")?.params,
    ).toEqual({ cwd: workspaceDir });
    expect(
      requests.filter((entry) => entry.method === "turn/start").at(-1)?.params,
    ).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", networkAccess },
    });
  },
  30_000,
);

it("fails visibly when Codex sandbox configuration cannot be read", async () => {
  writeFileSync(
    scriptPath,
    JSON.stringify({ requestLogPath, configReadError: true }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: autoAskSessionOptions,
  });
  expect((await harness.waitForResponse(1)).error?.message).toContain(
    "Configuration read unavailable",
  );
  expect(
    recordedRequests().some((entry) => entry.method === "thread/start"),
  ).toBe(false);
});

it.each(["thread/start", "thread/resume", "thread/fork"] as const)(
  "preserves a read-only named profile through %s and turn/start",
  async (method) => {
    writeFileSync(
      scriptPath,
      JSON.stringify({
        requestLogPath,
        configRead: { config: { default_permissions: ":read-only" } },
        permissionProfileListPages: {
          first: {
            data: [{ id: ":danger-full-access", allowed: false }],
            nextCursor: "second",
          },
          second: {
            data: [{ id: ":read-only", allowed: true }],
            nextCursor: null,
          },
        },
      }),
    );
    harness.sendRequest(1, method, {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: autoAskSessionOptions,
      ...(method === "thread/resume"
        ? { providerThreadId: "native-profile" }
        : {}),
      ...(method === "thread/fork"
        ? { sourceProviderThreadId: "native-profile" }
        : {}),
    });
    const response = await harness.waitForResponse(1);
    expect(response.error).toBeUndefined();

    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(response.result);

    harness.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: "creq_22222222ab",
      input: [{ type: "text", text: "Inspect files", mentions: [] }],
      options: autoAskSessionOptions,
    });
    expect((await harness.waitForResponse(2)).error).toBeUndefined();

    for (const request of recordedRequests().filter(
      (entry) => entry.method === method || entry.method === "turn/start",
    )) {
      expect(request.params).toMatchObject({ permissions: ":read-only" });
      expect(request.params).not.toHaveProperty("sandbox");
      expect(request.params).not.toHaveProperty("sandboxPolicy");
    }

    expect(
      recordedRequests()
        .filter((entry) => entry.method === "permissionProfile/list")
        .map((entry) => entry.params),
    ).toEqual([{ cwd: workspaceDir }, { cwd: workspaceDir, cursor: "second" }]);
  },
);

it("allows explicitly requested full access when only the full profile is permitted", async () => {
  writeFileSync(
    scriptPath,
    JSON.stringify({
      requestLogPath,
      configRequirementsRead: {
        requirements: {
          defaultPermissions: ":danger-full-access",
          allowedPermissionProfiles: {
            ":workspace": false,
            ":danger-full-access": true,
          },
        },
      },
      permissionProfileList: {
        data: [
          { id: ":workspace", allowed: false },
          { id: ":danger-full-access", allowed: true },
        ],
      },
    }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();
  expect(
    recordedRequests().find((entry) => entry.method === "thread/start")?.params,
  ).toMatchObject({ permissions: ":danger-full-access" });
});

function writeProfileScript(fullAccessAllowed: boolean): void {
  writeFileSync(
    scriptPath,
    JSON.stringify({
      requestLogPath,
      configRequirementsRead: {
        requirements: {
          defaultPermissions: "sandboxed",
          allowedPermissionProfiles: {
            sandboxed: true,
            ":danger-full-access": fullAccessAllowed,
          },
        },
      },
      permissionProfileList: {
        data: [
          { id: ":workspace", allowed: false },
          { id: ":danger-full-access", allowed: fullAccessAllowed },
          { id: "sandboxed", allowed: true },
        ],
      },
    }),
  );
}

it("runs workspace and full-access turns under Codex permission profiles required by the admin", async () => {
  writeProfileScript(true);
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: autoAskSessionOptions,
  });
  const started = await harness.waitForResponse(1);
  expect(started.error).toBeUndefined();

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  for (const [id, options] of [
    [2, autoAskSessionOptions],
    [3, FULL_ACCESS_SESSION_OPTIONS],
  ] as const) {
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: `creq_prfwrkxxx${id}`,
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options,
    });
    expect((await harness.waitForResponse(id)).error).toBeUndefined();
  }

  const requests = recordedRequests();
  const threadStart = requests.find((entry) => entry.method === "thread/start");
  expect(threadStart?.params).toMatchObject({ permissions: "sandboxed" });
  expect(threadStart?.params).not.toHaveProperty("sandbox");
  const turns = requests.filter((entry) => entry.method === "turn/start");
  expect(turns.map((entry) => entry.params.permissions)).toEqual([
    "sandboxed",
    ":danger-full-access",
  ]);
  expect(turns.some((entry) => "sandboxPolicy" in entry.params)).toBe(false);
}, 30_000);

it("rejects a full-access thread when Codex requirements disallow full access", async () => {
  writeProfileScript(false);
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  const started = await harness.waitForResponse(1);

  expect(started.error?.message).toContain(
    "Codex requirements on this machine do not allow full access",
  );
  expect(
    recordedRequests().filter((entry) => entry.method === "thread/start"),
  ).toEqual([]);
}, 30_000);

const SAVED_NATIVE_ID = "00000000-0000-4000-8000-000000000041";

function savedPoolFixture(originator = "bb") {
  const codexHome = join(workspaceDir, "native-home");
  const nativePath = join(codexHome, "sessions", "original.jsonl");
  const launchLogPath = join(workspaceDir, "launches.jsonl");
  const processLogPath = join(workspaceDir, "processes.log");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  vi.stubEnv("CODEX_HOME", codexHome);
  const configPath = join(codexHome, "config.toml");
  const config = 'model = "fixture-model"\n';
  writeFileSync(configPath, config);

  const header = {
    type: "session_meta",
    payload: {
      id: SAVED_NATIVE_ID,
      session_id: SAVED_NATIVE_ID,
      model_provider: "bb-account-pool",
      originator,
      cli_version: "0.166.0",
      source: "vscode",
      cwd: workspaceDir,
      runtime_workspace_roots: [workspaceDir],
    },
  };

  const original =
    JSON.stringify(header) +
    '\n{"type":"fixture-original-payload","value":"opaque-bb-input"}\n';

  writeFileSync(nativePath, original);

  const metadata = {
    id: SAVED_NATIVE_ID,
    sessionId: SAVED_NATIVE_ID,
    modelProvider: "bb-account-pool",
    path: nativePath,
    cwd: workspaceDir,
    cliVersion: "0.166.0",
    source: "vscode",
    forkedFromId: null,
    parentThreadId: null,
  };

  const configure = (
    patch: Record<string, unknown> = {},
    scriptPatch: Record<string, unknown> = {},
  ) => {
    writeFileSync(
      scriptPath,
      JSON.stringify({
        requestLogPath,
        launchLogPath,
        processLogPath,
        threadReadResults: { [SAVED_NATIVE_ID]: { ...metadata, ...patch } },
        ...scriptPatch,
      }),
    );
  };

  configure();

  const options = {
    ...FULL_ACCESS_SESSION_OPTIONS,
    envVars: {
      CODEX_OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
      CODEX_POOL_AUTH_TOKEN: "synthetic-fixture-capability",
    },
  };

  return {
    codexHome,
    nativePath,
    launchLogPath,
    processLogPath,
    configPath,
    config,
    header,
    original,
    metadata,
    configure,
    options,
  };
}

function poolFixtureLaunches(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          pid: z.number(),
          args: z.array(z.string()),
        })
        .parse(JSON.parse(line)),
    );
}

it.each(["bb", "bb_composer_predictions"])(
  "resumes an owned V1 native provider with %s origin without rewriting original bytes",
  async (originator) => {
    const fixture = savedPoolFixture(originator);
    harness.sendRequest(601, "thread/resume", {
      threadId: THREAD_ID,
      providerThreadId: SAVED_NATIVE_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fixture.options,
    });
    const response = await harness.waitForResponse(601);
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      providerThreadId: SAVED_NATIVE_ID,
    });

    const construction = recordedRequests().filter(
      (request) => request.method === "thread/resume",
    );

    expect(construction).toEqual([
      {
        method: "thread/resume",
        params: expect.objectContaining({
          threadId: SAVED_NATIVE_ID,
          modelProvider: "bb-account-pool",
          config: expect.objectContaining({
            model_provider: "bb-account-pool",
          }),
        }),
      },
    ]);
    const launches = poolFixtureLaunches(fixture.launchLogPath);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.args).toContain('model_provider="omnyo-account-pool"');
    expect(launches[1]?.args).toContain('model_provider="bb-account-pool"');
    expect(launches[1]?.args).toContain(
      'model_providers.bb-account-pool.base_url="http://127.0.0.1:1/v1"',
    );
    expect(launches[1]?.args).toContain(
      'model_providers.bb-account-pool.env_http_headers.x-omnyo-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    );
    expect(
      launches[1]?.args.some((arg) =>
        arg.startsWith("model_providers.omnyo-account-pool."),
      ),
    ).toBe(false);
    expect(
      recordedRequests()
        .filter((request) => request.method === "initialize")
        .every(
          (request) =>
            z
              .object({ clientInfo: z.object({ name: z.literal("omnyo") }) })
              .safeParse(request.params).success,
        ),
    ).toBe(true);
    expect(
      recordedRequests().filter((request) => request.method === "thread/read"),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: SAVED_NATIVE_ID, includeTurns: false },
      },
    ]);

    const lifecycle = readFileSync(fixture.processLogPath, "utf8")
      .trim()
      .split("\n");

    const reader = launches[0]?.pid,
      resumed = launches[1]?.pid;

    expect(
      lifecycle.findIndex((row) => row.startsWith(`exit:${reader}:`)),
    ).toBeLessThan(
      lifecycle.findIndex((row) => row.startsWith(`spawn:${resumed}:`)),
    );
    expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(fixture.config);
  },
);

it.each([
  "unknown-provider",
  "foreign-origin",
  "different-native-id",
  "different-session-id",
  "different-cli-metadata",
  "different-parent-link",
  "malformed-first-line",
  "missing-first-line",
  "oversized-first-line",
  "foreign-history-root",
] as const)(
  "refuses V1 native admission before construction for %s",
  async (failure) => {
    const fixture = savedPoolFixture();
    const differentId = "00000000-0000-4000-8000-000000000042";

    if (failure === "unknown-provider")
      fixture.configure({ modelProvider: "unowned-provider" });

    if (failure === "foreign-origin")
      fixture.header.payload.originator = "foreign-client";

    if (failure === "different-native-id")
      fixture.header.payload.id = differentId;

    if (failure === "different-session-id")
      fixture.header.payload.session_id = differentId;

    if (failure === "different-cli-metadata")
      fixture.header.payload.cli_version = "0.163.0";

    if (failure === "different-parent-link")
      fixture.configure({ parentThreadId: differentId });

    if (
      [
        "foreign-origin",
        "different-native-id",
        "different-session-id",
        "different-cli-metadata",
      ].includes(failure)
    )
      writeFileSync(fixture.nativePath, JSON.stringify(fixture.header) + "\n");

    if (failure === "malformed-first-line")
      writeFileSync(fixture.nativePath, "{invalid-native-metadata}\n");

    if (failure === "missing-first-line") writeFileSync(fixture.nativePath, "");

    if (failure === "oversized-first-line")
      writeFileSync(fixture.nativePath, " ".repeat(1024 * 1024 + 1) + "\n");

    if (failure === "foreign-history-root") {
      const foreign = join(workspaceDir, "outside-native-home.jsonl");
      writeFileSync(foreign, fixture.original);
      fixture.configure({ path: foreign });
    }

    const original = readFileSync(fixture.nativePath);
    harness.sendRequest(602, "thread/resume", {
      threadId: THREAD_ID,
      providerThreadId: SAVED_NATIVE_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fixture.options,
    });
    const response = await harness.waitForResponse(602);
    expect(response.error).toBeDefined();
    expect(
      recordedRequests().filter((request) =>
        ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(
          request.method,
        ),
      ),
    ).toEqual([]);
    expect(poolFixtureLaunches(fixture.launchLogPath)).toHaveLength(1);
    expect(readFileSync(fixture.nativePath)).toEqual(original);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(fixture.config);
  },
);

it("refuses an original V1 native fork without emitting an old-provider new identity", async () => {
  const fixture = savedPoolFixture();
  harness.sendRequest(603, "thread/fork", {
    threadId: THREAD_ID,
    sourceProviderThreadId: SAVED_NATIVE_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: fixture.options,
  });
  const response = await harness.waitForResponse(603);
  expect(response.error?.message).toContain("cannot be forked");
  expect(
    recordedRequests().some((request) => request.method === "thread/fork"),
  ).toBe(false);
  expect(poolFixtureLaunches(fixture.launchLogPath)).toHaveLength(1);
  expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
});

it("reuses the canonical native connection for a current saved provider", async () => {
  const fixture = savedPoolFixture();
  fixture.configure({ modelProvider: "omnyo-account-pool", path: null });
  harness.sendRequest(604, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: SAVED_NATIVE_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: fixture.options,
  });
  expect((await harness.waitForResponse(604)).error).toBeUndefined();
  expect(poolFixtureLaunches(fixture.launchLogPath)).toHaveLength(1);
  expect(
    recordedRequests().find((request) => request.method === "thread/resume")
      ?.params,
  ).toMatchObject({ modelProvider: "omnyo-account-pool" });
  expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
});

it("forks a default-provider native session into the pool route without touching the original", async () => {
  const fixture = savedPoolFixture("codex-tui");
  fixture.configure({ modelProvider: "openai", path: null });
  harness.sendRequest(605, "thread/fork", {
    threadId: THREAD_ID,
    sourceProviderThreadId: SAVED_NATIVE_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: fixture.options,
  });
  expect((await harness.waitForResponse(605)).error).toBeUndefined();
  expect(
    recordedRequests().find((request) => request.method === "thread/fork")
      ?.params,
  ).toMatchObject({
    threadId: SAVED_NATIVE_ID,
    modelProvider: "omnyo-account-pool",
    config: { model_provider: "omnyo-account-pool" },
  });
  expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
});

it.each([
  ["thread/resume", "openai"],
  ["thread/fork", "custom-endpoint"],
] as const)(
  "still refuses %s of a %s session while the pool routes Codex",
  async (method, modelProvider) => {
    const fixture = savedPoolFixture("codex-tui");
    fixture.configure({ modelProvider, path: null });
    harness.sendRequest(606, method, {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fixture.options,
      ...(method === "thread/resume"
        ? { providerThreadId: SAVED_NATIVE_ID }
        : { sourceProviderThreadId: SAVED_NATIVE_ID }),
    });
    expect((await harness.waitForResponse(606)).error?.message).toContain(
      "does not match the configured Account Pool route",
    );
    expect(
      recordedRequests().some((request) => request.method === method),
    ).toBe(false);
    expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
  },
);

it("keeps V1 provider admission on the existing session rebuild path", async () => {
  const fixture = savedPoolFixture();
  harness.sendRequest(605, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: SAVED_NATIVE_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: fixture.options,
  });
  expect((await harness.waitForResponse(605)).error).toBeUndefined();
  harness.sendRequest(606, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: SAVED_NATIVE_ID,
    clientRequestId: "creq_finitev222",
    input: [{ type: "text", text: "fixture-only turn", mentions: [] }],
    options: { ...fixture.options, reasoningLevel: "high" },
  });
  expect((await harness.waitForResponse(606)).error).toBeUndefined();

  const resumes = recordedRequests().filter(
    (request) => request.method === "thread/resume",
  );

  expect(resumes).toHaveLength(2);
  expect(
    resumes.every(
      (request) =>
        z
          .object({
            threadId: z.literal(SAVED_NATIVE_ID),
            modelProvider: z.literal("bb-account-pool"),
          })
          .safeParse(request.params).success,
    ),
  ).toBe(true);
  expect(poolFixtureLaunches(fixture.launchLogPath)).toHaveLength(4);
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        providerThreadId: SAVED_NATIVE_ID,
        contextLost: false,
      }),
    }),
  ]);
  expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
});

it("stops V1 metadata admission before a released session can install a native writer", async () => {
  const fixture = savedPoolFixture();
  fixture.configure({}, { threadReadDelayMs: 2000 });
  harness.sendRequest(607, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: SAVED_NATIVE_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: fixture.options,
  });
  await vi.waitFor(
    () => {
      expect(
        recordedRequests().some((request) => request.method === "thread/read"),
      ).toBe(true);
    },
    { timeout: 3000 },
  );
  harness.sendRequest(608, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: SAVED_NATIVE_ID,
    intent: "release",
    activeTurnId: null,
  });
  expect((await harness.waitForResponse(608)).error).toBeUndefined();
  expect((await harness.waitForResponse(607)).error).toBeDefined();
  expect(poolFixtureLaunches(fixture.launchLogPath)).toHaveLength(1);
  expect(
    recordedRequests().some((request) => request.method === "thread/resume"),
  ).toBe(false);
  expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
});

it.each([true, false])(
  "does not carry V1 provider admission into a fresh session (pooled: %s)",
  async (pooled) => {
    const fixture = savedPoolFixture();
    harness.sendRequest(609, "thread/resume", {
      threadId: THREAD_ID,
      providerThreadId: SAVED_NATIVE_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fixture.options,
    });
    expect((await harness.waitForResponse(609)).error).toBeUndefined();
    harness.sendRequest(610, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: pooled
        ? fixture.options
        : {
            ...FULL_ACCESS_SESSION_OPTIONS,
            envVars: { CODEX_OPENAI_BASE_URL: "", CODEX_POOL_AUTH_TOKEN: "" },
          },
    });
    expect((await harness.waitForResponse(610)).error).toBeUndefined();
    const launches = poolFixtureLaunches(fixture.launchLogPath);
    expect(launches).toHaveLength(3);
    expect(
      launches.at(-1)?.args.some((arg) => arg.includes("bb-account-pool")),
    ).toBe(false);

    const started = recordedRequests().find(
      (request) => request.method === "thread/start",
    );

    expect(started?.params).toMatchObject(
      pooled ? { modelProvider: "omnyo-account-pool" } : {},
    );

    if (!pooled) expect(started?.params).not.toHaveProperty("modelProvider");
    expect(
      recordedRequests().filter((request) => request.method === "thread/read"),
    ).toHaveLength(1);
    expect(readFileSync(fixture.nativePath, "utf8")).toBe(fixture.original);
  },
);

it.each(["root", "child"])("changes speed with %s turns", async (mode) => {
  writeFileSync(
    scriptPath,
    JSON.stringify({ requestLogPath, interruptQueueMode: mode }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });

  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse((await harness.waitForResponse(1)).result);

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_speedstart",
    input: [{ type: "text", text: "keep working", mentions: [] }],
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  expect((await harness.waitForResponse(2)).error).toBeUndefined();

  for (const [index, serviceTier] of [
    "fast",
    "ultrafast",
    "default",
  ].entries()) {
    harness.sendRequest(3 + index, "thread/speed/set", {
      threadId: THREAD_ID,
      providerThreadId,
      serviceTier,
    });
    expect((await harness.waitForResponse(3 + index)).error).toBeUndefined();
    expect(recordedRequests().slice(-2)).toEqual([
      {
        method: "thread/settings/update",
        params: {
          threadId: providerThreadId,
          serviceTier: serviceTier === "default" ? null : serviceTier,
        },
      },
      {
        method: "turn/settings/update",
        params: {
          threadId: providerThreadId,
          turnId: "turn-fx-1",
          serviceTier: serviceTier === "default" ? null : serviceTier,
        },
      },
    ]);
  }

  expect(
    recordedRequests().filter((request) => request.method === "turn/start"),
  ).toHaveLength(1);
  expect(
    recordedRequests().some((request) => request.method === "turn/interrupt"),
  ).toBe(false);
  expect(
    harness.messages.some((message) => message.method === "session/replaced"),
  ).toBe(false);
});

it.each([
  {
    method: "thread/start",
    userAgent: "omnyo/0.145.0 (Linux; x86_64)",
    modern: true,
  },
  {
    method: "thread/resume",
    userAgent: "omnyo/0.169.0 (Mac OS 27.2.1; arm64)",
    modern: true,
  },
  {
    method: "thread/fork",
    userAgent: "omnyo/0.145.0 (Linux; x86_64)",
    modern: true,
  },
  {
    method: "thread/start",
    userAgent: "omnyo/0.145.0-alpha.1 (Linux; x86_64)",
    modern: false,
  },
  { method: "thread/resume", userAgent: undefined, modern: false },
] as const)(
  "$method selects compatible subagent configuration for $userAgent",
  async ({ method, userAgent, modern }) => {
    writeFileSync(
      scriptPath,
      JSON.stringify({
        requestLogPath,
        initializeResult: { userAgent },
      }),
    );
    harness.sendRequest(1, method, {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      ...(method === "thread/resume"
        ? { providerThreadId: "existing-thread" }
        : {}),
      ...(method === "thread/fork"
        ? { sourceProviderThreadId: "existing-thread" }
        : {}),
      options: {
        ...FULL_ACCESS_SESSION_OPTIONS,
        providerOptions: { providerSubagentsEnabled: false },
      },
    });
    expect((await harness.waitForResponse(1)).error).toBeUndefined();
    const request = recordedRequests().find((entry) => entry.method === method);

    const { config } = z
      .object({ config: z.record(z.string(), z.unknown()) })
      .parse(request?.params);

    expect(
      Object.fromEntries(
        Object.entries(config).filter(
          ([key]) =>
            key.startsWith("features.multi_agent") || key === "agents.enabled",
        ),
      ),
    ).toEqual(
      modern
        ? {
            "agents.enabled": false,
            "features.multi_agent_v2": false,
          }
        : {
            "features.multi_agent": false,
            "features.multi_agent_v2.max_concurrent_threads_per_session": 1,
          },
    );
  },
  30_000,
);
