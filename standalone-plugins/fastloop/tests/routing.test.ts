import { expect, it } from "vitest";
import type { ContextBinding, JsonPayload, RunOwnership, SessionOwnership } from "../contracts.js";
import {
  createRouting,
  parseRequirementsJSON,
  type Caller,
  type ContextReader,
  type RoutingTransport,
} from "../routing.js";

const requirements = [
  {
    id: "persist",
    text: "Saved names persist after reload",
    kind: "functional",
    required: true,
    origin: "caller",
  },
];

const submit: JsonPayload = {
  requestId: "request-a",
  submission: {
    kind: "verify",
    request: { url: "http://localhost:4000/settings", goal: "Verify persistence", requirements },
  },
};

const signal = AbortSignal.timeout(10000);

const native: Caller = {
  kind: "native_tool",
  context: { threadId: "thread-a", projectId: "project-a" },
};

const owner: Caller = {
  kind: "owner",
  surface: "cli",
  inherited: { threadId: "thread-a", projectId: "project-a", cwd: "/invoker/not-the-host" },
};

function fixture(retainedRead?: RoutingTransport["retainedRead"]) {
  const threads = new Map<string, Awaited<ReturnType<ContextReader["thread"]>>>([
    ["thread-a", { id: "thread-a", projectId: "project-a", environmentId: "environment-a" }],
    ["thread-b", { id: "thread-b", projectId: "project-a", environmentId: "environment-b" }],
  ]);

  const environments = new Map<string, Awaited<ReturnType<ContextReader["environment"]>>>([
    [
      "environment-a",
      {
        id: "environment-a",
        projectId: "project-a",
        hostId: "host-a",
        path: "/host/worktree-a",
        isGitRepo: true,
      },
    ],
    [
      "environment-b",
      {
        id: "environment-b",
        projectId: "project-a",
        hostId: "host-b",
        path: "/host/worktree-b",
        isGitRepo: true,
      },
    ],
  ]);

  const inspection = {
    canonicalRoot: "/host/worktree-a",
    candidateCanonicalPath: "/host/worktree-a",
    withinWorkspace: true,
    directory: true,
    workspaceId: "shared-git-common-dir",
    policyHash: "a".repeat(64),
    platform: "darwin",
    arch: "arm64",
  };

  const hosts = new Map<string, Awaited<ReturnType<ContextReader["host"]>>>([
    ["host-a", { id: "host-a", status: "connected" }],
    ["host-b", { id: "host-b", status: "connected" }],
  ]);

  const reads: string[] = [];

  const reader: ContextReader = {
    async thread(id) {
      reads.push(`thread:${id}`);
      const value = threads.get(id);

      if (!value) throw new Error("THREAD_NOT_FOUND");

      return value;
    },
    async environment(id) {
      reads.push(`environment:${id}`);
      const value = environments.get(id);

      if (!value) throw new Error("ENVIRONMENT_NOT_FOUND");

      return value;
    },
    async project(id) {
      reads.push(`project:${id}`);

      return { id };
    },
    async host(id) {
      reads.push(`host:${id}`);
      const value = hosts.get(id);

      if (!value) throw new Error("HOST_NOT_FOUND");

      return value;
    },
  };

  const calls: {
    method: string;
    hostId: string;
    binding?: ContextBinding;
    payload?: JsonPayload;
    candidatePath?: string;
  }[] = [];

  const transport: RoutingTransport = {
    retainedRead,
    async inspectWorkspace(input, options) {
      calls.push({
        method: "inspectWorkspace",
        hostId: options.hostId,
        candidatePath: input.candidatePath,
      });

      return { ...inspection };
    },
    async invokeControl(method, input, options): Promise<JsonPayload> {
      calls.push({ method, hostId: options.hostId, payload: input.payload });

      return { ok: true };
    },
    async invoke(method, input, options): Promise<JsonPayload> {
      calls.push({ method, hostId: options.hostId, ...input });

      return method === "submit"
        ? { runId: "run-a", sessionId: "session-a", state: "accepted" }
        : { ok: true };
    },
  };

  const runs = new Map<string, RunOwnership>();
  const sessions = new Map<string, SessionOwnership>();

  const router = createRouting({
    reader,
    transport,
    supportedTargets: new Set(["darwin:arm64", "linux:x64"]),
    ownership: {
      async getRun(id) {
        return runs.get(id);
      },
      async getSession(id) {
        return sessions.get(id);
      },
      async rememberRun(record) {
        runs.set(record.runId, record);
      },
      async rememberSession(record) {
        sessions.set(record.sessionId, record);
      },
    },
  });

  return { router, threads, environments, hosts, inspection, calls, reads, runs, sessions };
}

it("resolves the actual selected thread environment path on its actual host", async () => {
  const f = fixture();
  await f.router.dispatch({
    caller: owner,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  expect(f.calls).toMatchObject([
    { method: "inspectWorkspace", hostId: "host-a", candidatePath: "/host/worktree-a" },
    {
      method: "submit",
      hostId: "host-a",
      binding: {
        threadId: "thread-a",
        environmentId: "environment-a",
        canonicalRoot: "/host/worktree-a",
      },
    },
  ]);
  expect(JSON.stringify(f.calls)).not.toContain("/invoker/not-the-host");
  expect(f.runs.get("run-a")?.binding.hostId).toBe("host-a");
});

it("native tool context ignores caller-supplied thread, project and host overrides", async () => {
  const f = fixture();
  await f.router.dispatch({
    caller: native,
    selectors: {
      threadId: "thread-b",
      projectId: "forged-project",
      hostId: "host-b",
      canonicalRoot: "/attacker",
    },
    method: "doctor",
    payload: {},
    signal,
  });
  expect(f.calls[1]).toMatchObject({
    method: "doctor",
    hostId: "host-a",
    binding: { threadId: "thread-a", projectId: "project-a" },
  });
});

for (const method of ["result", "events", "artifact", "cancel"] as const)
  it(`rejects a foreign native tool ${method} despite a spoofed owner thread selector`, async () => {
    const f = fixture();
    await f.router.dispatch({
      caller: native,
      selectors: {},
      method: "submit",
      payload: submit,
      signal,
    });
    const before = f.calls.filter((call) => call.method !== "inspectWorkspace").length;
    await expect(
      f.router.dispatch({
        caller: { kind: "native_tool", context: { threadId: "thread-b", projectId: "project-a" } },
        selectors: { threadId: "thread-a" },
        method,
        payload: { runId: "run-a" },
        signal,
      }),
    ).rejects.toThrow("FOREIGN_THREAD_RUN");
    expect(f.calls.filter((call) => call.method !== "inspectWorkspace")).toHaveLength(before);
  });

it("owner UI may select a thread but its run must match the selected context", async () => {
  const f = fixture();
  await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  await expect(
    f.router.dispatch({
      caller: { kind: "owner", surface: "ui" },
      selectors: { threadId: "thread-b" },
      method: "result",
      payload: { runId: "run-a" },
      signal,
    }),
  ).rejects.toThrow("RUN_CONTEXT_MISMATCH");
  await f.router.dispatch({
    caller: { kind: "owner", surface: "ui" },
    selectors: { threadId: "thread-a" },
    method: "result",
    payload: { runId: "run-a" },
    signal,
  });
});

for (const selectors of [{ threadId: "thread-b" }, { projectId: "project-b" }])
  it("rejects conflicting inherited CLI selectors before host inspection", async () => {
    const f = fixture();
    await expect(f.router.resolve(owner, selectors, signal)).rejects.toThrow(
      "CLI_CONTEXT_CONFLICT",
    );
    expect(f.calls).toEqual([]);
  });

it("requires an actual thread and never picks a host from cwd", async () => {
  const f = fixture();
  await expect(
    f.router.resolve(
      { kind: "owner", surface: "cli", inherited: { cwd: "/host/worktree-a" } },
      {},
      signal,
    ),
  ).rejects.toThrow("THREAD_REQUIRED");
  expect(f.reads).toEqual([]);
});

for (const [name, update, code] of [
  [
    "missing environment",
    (f: ReturnType<typeof fixture>) => {
      const thread = f.threads.get("thread-a");

      if (thread) thread.environmentId = null;
    },
    "ENVIRONMENT_REQUIRED",
  ],
  [
    "null checkout",
    (f: ReturnType<typeof fixture>) => {
      const environment = f.environments.get("environment-a");

      if (environment) environment.path = null;
    },
    "WORKSPACE_REQUIRED",
  ],
  [
    "wrong project",
    (f: ReturnType<typeof fixture>) => {
      const environment = f.environments.get("environment-a");

      if (environment) environment.projectId = "other-project";
    },
    "PROJECT_CONTEXT_MISMATCH",
  ],
  [
    "offline host",
    (f: ReturnType<typeof fixture>) => {
      const host = f.hosts.get("host-a");

      if (host) host.status = "disconnected";
    },
    "HOST_OFFLINE",
  ],
  [
    "escaped workspace",
    (f: ReturnType<typeof fixture>) => {
      f.inspection.withinWorkspace = false;
    },
    "WORKSPACE_ESCAPE",
  ],
  [
    "non-root checkout",
    (f: ReturnType<typeof fixture>) => {
      f.inspection.candidateCanonicalPath = "/host/worktree-a/subdir";
    },
    "WORKSPACE_ESCAPE",
  ],
  [
    "unsupported platform",
    (f: ReturnType<typeof fixture>) => {
      f.inspection.platform = "freebsd";
    },
    "UNSUPPORTED_PLATFORM",
  ],
] as const)
  it(`distinguishes ${name}`, async () => {
    const f = fixture();
    update(f);
    await expect(
      f.router.dispatch({ caller: native, selectors: {}, method: "doctor", payload: {}, signal }),
    ).rejects.toThrow(code);
    expect(f.calls.some((call) => call.method === "doctor")).toBe(false);
  });

for (const [name, update, code] of [
  [
    "host",
    (f: ReturnType<typeof fixture>) => {
      const environment = f.environments.get("environment-a");

      if (environment) environment.hostId = "host-b";
    },
    "HOST_CONTEXT_CHANGED",
  ],
  [
    "same repository different worktree",
    (f: ReturnType<typeof fixture>) => {
      f.inspection.canonicalRoot = "/host/worktree-b";
      f.inspection.candidateCanonicalPath = "/host/worktree-b";
    },
    "WORKTREE_CONTEXT_CHANGED",
  ],
  [
    "policy",
    (f: ReturnType<typeof fixture>) => {
      f.inspection.policyHash = "b".repeat(64);
    },
    "POLICY_CONTEXT_CHANGED",
  ],
] as const)
  it(`refuses session reuse after ${name} changes`, async () => {
    const f = fixture();
    await f.router.dispatch({
      caller: native,
      selectors: {},
      method: "submit",
      payload: submit,
      signal,
    });
    update(f);

    const reuse: JsonPayload = {
      requestId: "request-b",
      submission: {
        kind: "verify",
        request: {
          url: "http://localhost:4000/settings",
          goal: "Recheck",
          requirements,
          sessionId: "session-a",
          previousRunId: "run-a",
        },
      },
    };

    await expect(
      f.router.dispatch({
        caller: native,
        selectors: {},
        method: "submit",
        payload: reuse,
        signal,
      }),
    ).rejects.toThrow(code);
    expect(f.calls.filter((call) => call.method === "submit")).toHaveLength(1);
  });

it("does not overwrite another thread ownership if a host returns an already owned handle", async () => {
  const f = fixture();
  await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  await expect(
    f.router.dispatch({
      caller: { kind: "native_tool", context: { threadId: "thread-b", projectId: "project-a" } },
      selectors: {},
      method: "submit",
      payload: submit,
      signal,
    }),
  ).rejects.toThrow("FOREIGN_THREAD_RUN");
  expect(f.runs.get("run-a")?.binding.threadId).toBe("thread-a");
});

it("requires the bound session for an explicit previous run", async () => {
  const f = fixture();
  await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  await expect(
    f.router.dispatch({
      caller: native,
      selectors: {},
      method: "submit",
      payload: {
        requestId: "request-b",
        submission: { kind: "verify", request: { previousRunId: "run-a", requirements } },
      },
      signal,
    }),
  ).rejects.toThrow("SESSION_REQUIRED_FOR_REUSE");
});

it("validates required scope before runtime submission", async () => {
  const f = fixture();
  await expect(
    f.router.dispatch({
      caller: native,
      selectors: {},
      method: "submit",
      payload: {
        requestId: "request-a",
        submission: { kind: "verify", request: { requirements: [] } },
      },
      signal,
    }),
  ).rejects.toThrow();
  expect(f.calls.some((call) => call.method === "submit")).toBe(false);
});

it("accepts one compact bounded requirement line and rejects file paths, pretty JSON and invalid scope", () => {
  expect(parseRequirementsJSON(JSON.stringify(requirements))).toEqual(requirements);

  for (const value of [
    "/caller/requirements.json",
    JSON.stringify(requirements, null, 2),
    "[]",
    "[",
    JSON.stringify([{ ...requirements[0], required: false }]),
    "x".repeat(16385),
  ])
    expect(() => parseRequirementsJSON(value)).toThrow();
});

it("allows only owner bootstrap control through an actual selected environment", async () => {
  const setup = fixture();
  await expect(
    setup.router.dispatch({
      caller: { kind: "owner", surface: "cli" },
      selectors: { projectId: "project-a", environmentId: "environment-a" },
      method: "doctor",
      payload: {},
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual({ ok: true });
  expect(setup.reads).not.toContain("thread:thread-a");
  expect(setup.calls.at(-1)?.method).toBe("doctor");
  await expect(
    setup.router.dispatch({
      caller: { kind: "native_tool", context: { threadId: "thread-a", projectId: "project-a" } },
      selectors: {},
      method: "setup",
      payload: {},
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("OWNER_SETUP_REQUIRED");
});

it("reads a retained owned result only through the original connected host after checkout removal", async () => {
  const calls: string[] = [];

  const f = fixture(async (input, options) => {
    calls.push(`${options.hostId}:${input.candidatePath}:${input.method}`);

    return {
      missing: true,
      result: { runId: "run-a", state: "completed", result: { verdict: "FAILED" } },
    };
  });

  await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  f.calls.length = 0;

  const result = await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "result",
    payload: { runId: "run-a" },
    signal,
  });

  expect(result).toMatchObject({ result: { verdict: "FAILED" } });
  expect(calls).toEqual(["host-a:/host/worktree-a:result"]);
  expect(f.calls).toEqual([]);
  f.environments.get("environment-a")!.hostId = "host-b";
  await expect(
    f.router.dispatch({
      caller: native,
      selectors: {},
      method: "result",
      payload: { runId: "run-a" },
      signal,
    }),
  ).rejects.toThrow("HOST_CONTEXT_CHANGED");
  expect(calls).toHaveLength(1);
});

it("propagates archive refusal without live coordinator fallback", async () => {
  const f = fixture(async () => {
    throw new Error("ARCHIVE_COORDINATOR_ACTIVE");
  });

  await f.router.dispatch({
    caller: native,
    selectors: {},
    method: "submit",
    payload: submit,
    signal,
  });
  f.calls.length = 0;
  await expect(
    f.router.dispatch({
      caller: native,
      selectors: {},
      method: "artifact",
      payload: { runId: "run-a", evidenceId: "report" },
      signal,
    }),
  ).rejects.toThrow("ARCHIVE_COORDINATOR_ACTIVE");
  expect(f.calls).toEqual([]);
});
