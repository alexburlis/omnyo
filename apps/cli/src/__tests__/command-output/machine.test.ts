import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Host } from "@omnyo/domain";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import {
  formatMachineLastSeen,
  registerMachineCommands,
  resolveMachineId,
} from "../../commands/machine.js";

const hosts: Host[] = [
  {
    id: "host-primary",
    name: "workstation",
    type: "persistent",
    status: "connected",
    machineProviderId: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: "full",
    availability: "available",
    lastSeenAt: 1_700_000_000_000,
    lastRejectedProtocolVersion: null,
    runtimeVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "host-remote",
    name: "laptop",
    type: "persistent",
    status: "disconnected",
    machineProviderId: "ssh",
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: "full",
    availability: "available",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    runtimeVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
];

const creating: Host = {
  ...hosts[1]!,
  lifecycle: {
    ...hosts[1]!.lifecycle,
    phase: "creating",
    message: "Creating SSH machine…",
  },
};

describe("omnyo machine command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerMachineCommands(program, () => "http://server");

  it("shows failed housekeeping as unknown through the SDK", async () => {
    const housekeeping = vi.fn(async () => ({
      status: "failed",
      checkedAt: 1_700_000_000_000,
      memoryPressure: { status: "unavailable", reason: "read-failed" },
      idleGraceMs: 600_000,
    }));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.housekeeping.$get": housekeeping,
    });
    await runCommand(["machine", "housekeeping", "workstation"], register);
    expect(housekeeping).toHaveBeenCalledWith({
      param: { id: "host-primary" },
    });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Retained sessions are unknown");
    expect(output).not.toContain("Retained sessions: 0");
  });

  it("preserves retained session reasons and process measurements in housekeeping JSON", async () => {
    const status = {
      status: "complete",
      checkedAt: 1_700_000_000_000,
      memoryPressure: { status: "observed", level: "warning" },
      idleGraceMs: 120_000,
      reapedSessions: [],
      retainedSessions: [
        {
          threadId: "thread-1",
          providerId: "codex",
          processId: 12345,
          environmentId: "env-1",
          reason: "background-work",
          idleForMs: 300_000,
          memory: { status: "observed", source: "rss", bytes: 104857600 },
        },
      ],
    };

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.housekeeping.$get": vi.fn(async () => status),
    });
    await runCommand(
      ["machine", "housekeeping", "workstation", "--json"],
      register,
    );
    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log))[0] ?? "null"),
    ).toEqual(status);
  });

  it.each([false, true])(
    "provider CLI update keeps chat interruption explicit (%s)",
    async (now) => {
      const install = vi.fn(
        async () =>
          new Response(
            [
              JSON.stringify({
                type: "progress",
                provider: "codex",
                phase: "pausing",
                message: "Pausing chats.",
              }),
              JSON.stringify({
                type: "completed",
                provider: "codex",
                success: true,
                exitCode: 0,
                signal: null,
              }),
            ].join("\n"),
          ),
      );

      stubServerApi({
        "v1.hosts.$get": vi.fn(async () => hosts),
        "v1.hosts.:id.provider-clis.install.$post": install,
      });
      await runCommand(
        [
          "machine",
          "provider-cli",
          "install",
          "workstation",
          "codex",
          "--action",
          "update",
          ...(now ? ["--yes"] : []),
        ],
        register,
      );
      expect(install).toHaveBeenCalledOnce();
      expect(install).toHaveBeenCalledWith(
        expect.objectContaining({
          json: expect.objectContaining({ confirmInterruptingThreads: now }),
        }),
      );
      expect(collectLogPayloads(vi.mocked(console.log))).toHaveLength(2);
    },
  );

  it.each([
    {
      name: "available worker with no probe",
      directAccess: {
        status: "available",
        coordinator: {
          held: false,
          phase: "idle",
          instanceId: "coordinator-current",
          sessionId: "session-current",
          ownerFingerprint: null,
        },
        worker: {
          status: "available",
          hostId: "host-primary",
          workerInstanceId: "worker-current",
          sessionId: "session-current",
          probe: null,
        },
      },
    },
    {
      name: "foreign committed worker ownership while coordinator is held",
      directAccess: {
        status: "available",
        coordinator: {
          held: true,
          phase: "release-uncertain",
          instanceId: "coordinator-current",
          sessionId: "session-current",
          ownerFingerprint: "a".repeat(64),
        },
        worker: {
          status: "available",
          hostId: "host-primary",
          workerInstanceId: "worker-current",
          sessionId: "session-current",
          probe: {
            phase: "committed",
            ownerFingerprint: "b".repeat(64),
            coordinatorInstanceId: "coordinator-foreign",
            sessionId: null,
          },
        },
      },
    },
    {
      name: "unavailable worker inspection",
      directAccess: {
        status: "available",
        coordinator: {
          held: true,
          phase: "release-uncertain",
          instanceId: "coordinator-current",
          sessionId: "session-current",
          ownerFingerprint: "a".repeat(64),
        },
        worker: {
          status: "unavailable",
          code: "host_offline",
          message: "Worker is not connected",
        },
      },
    },
    {
      name: "ownership inspection forbidden to machine credentials",
      directAccess: {
        status: "unavailable",
        code: "machine_host_management_forbidden",
        message: "Machine credentials cannot inspect direct access ownership",
      },
    },
  ])(
    "omnyo machine show --json preserves $name through the SDK",
    async ({ directAccess }) => {
      const host = {
        ...hosts[0]!,
        directAccess,
      };

      const get = vi.fn(async () => host);
      stubServerApi({
        "v1.hosts.$get": vi.fn(async () => hosts),
        "v1.hosts.:id.$get": get,
      });

      await runCommand(["machine", "show", "workstation", "--json"], register);

      expect(get).toHaveBeenCalledWith({ param: { id: "host-primary" } });
      expect(collectLogPayloads(vi.mocked(console.log))).toHaveLength(1);
      expect(
        JSON.parse(collectLogPayloads(vi.mocked(console.log))[0]!),
      ).toEqual(host);
    },
  );

  it("polls the creating host until it becomes active", async () => {
    const get = vi.fn(async () => hosts[1]);
    stubServerApi({
      "v1.hosts.$post": vi.fn(async () => creating),
      "v1.hosts.:id.enrollment-command.$get": vi.fn(async () => null),
      "v1.hosts.:id.$get": get,
    });
    await runCommand(["machine", "create", "--provider", "ssh"], register);
    expect(get).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine laptop created",
    ]);
  });

  it("prints the host from --no-wait without polling", async () => {
    const get = vi.fn(async () => hosts[1]);
    stubServerApi({
      "v1.hosts.$post": vi.fn(async () => creating),
      "v1.hosts.:id.$get": get,
    });
    await runCommand(
      ["machine", "create", "--provider", "ssh", "--no-wait", "--json"],
      register,
    );
    expect(get).not.toHaveBeenCalled();
    expect(JSON.parse(collectLogPayloads(vi.mocked(console.log))[0])).toEqual(
      creating,
    );
  });

  it("prints a reconnect command and waits for the same host", async () => {
    const reconnect = vi.fn(async () => ({
      command: "curl -fsSL reconnect | sh",
      expiresAt: Date.now() + 60_000,
      hostId: "host-remote",
    }));

    const get = vi.fn(async () => ({
      ...hosts[1]!,
      status: "connected" as const,
    }));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.reconnect-commands.$post": reconnect,
      "v1.hosts.:id.$get": get,
    });
    await runCommand(["machine", "reconnect", "laptop"], register);
    expect(reconnect).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote keeps its host ID. Run this command on the machine within 15 minutes:",
      "",
      "curl -fsSL reconnect | sh",
      "Machine host-remote reconnected successfully.",
    ]);
  });

  it("prints the manual enrollment command while following", async () => {
    const command = "curl -fsSL https://machine.example/install.sh | sh";
    stubServerApi({
      "v1.hosts.$post": vi.fn(async () => creating),
      "v1.hosts.:id.enrollment-command.$get": vi.fn(async () => ({
        command,
        expiresAt: Date.now() + 60_000,
      })),
      "v1.hosts.:id.$get": vi.fn(async () => hosts[1]),
    });
    await runCommand(["machine", "create", "--provider", "manual"], register);
    expect(collectLogPayloads(vi.mocked(console.error))).toContain(command);
  });

  it("prints the short setup command before the full fallback", async () => {
    const command =
      "curl -sS --fail-with-body https://machine.example/install.sh | sh";

    const shortCommand = {
      code: "AB12-CD34",
      command: "curl -fsSL https://machine.example/m/AB12-CD34 | sh",
      windowsCommand: "irm https://machine.example/m/AB12-CD34.ps1 | iex",
      pageUrl: "https://machine.example/m/AB12-CD34",
      expiresAt: Date.now() + 60_000,
    };

    stubServerApi({
      "v1.hosts.$post": vi.fn(async () => creating),
      "v1.hosts.:id.enrollment-command.$get": vi.fn(async () => ({
        command,
        windowsCommand: "irm full | iex",
        expiresAt: Date.now() + 120_000,
        shortCommand,
      })),
      "v1.hosts.:id.$get": vi.fn(async () => hosts[1]),
    });
    await runCommand(["machine", "create", "--provider", "manual"], register);
    const printed = collectLogPayloads(vi.mocked(console.error));
    expect(printed).toContain("Setup code: AB12-CD34");
    expect(printed.indexOf(shortCommand.command)).toBeGreaterThanOrEqual(0);
    expect(printed.indexOf(shortCommand.windowsCommand)).toBeGreaterThan(
      printed.indexOf(shortCommand.command),
    );
    expect(printed.indexOf(command)).toBeGreaterThan(
      printed.indexOf(shortCommand.windowsCommand),
    );
    expect(printed).toContain(
      "Or open https://machine.example/m/AB12-CD34 in a browser on that machine and copy the command there.",
    );
  });

  it("waits for delayed manual enrollment readiness and prints the command once", async () => {
    const command = "curl -fsSL https://machine.example/install.sh | sh";

    const enrollment = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ command, expiresAt: Date.now() + 60_000 });

    const get = vi
      .fn()
      .mockResolvedValueOnce(creating)
      .mockResolvedValueOnce(creating)
      .mockResolvedValue(hosts[1]);

    stubServerApi({
      "v1.hosts.$post": vi.fn(async () => creating),
      "v1.hosts.:id.enrollment-command.$get": enrollment,
      "v1.hosts.:id.$get": get,
    });
    await runCommand(["machine", "create", "--provider", "manual"], register);
    expect(
      collectLogPayloads(vi.mocked(console.error)).filter(
        (value) => value === command,
      ),
    ).toEqual([command]);
    expect(enrollment).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed JSON without submitting inputs", async () => {
    const create = vi.fn(async () => creating);
    stubServerApi({ "v1.hosts.$post": create });
    await expect(
      runCommand(
        [
          "machine",
          "create",
          "--provider",
          "ssh",
          "--inputs",
          '{"credential":"secret"',
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(create).not.toHaveBeenCalled();
  });

  it("aborts the create request on SIGINT", async () => {
    const create = vi.fn(
      async (_request: object, options: { init: { signal: AbortSignal } }) => {
        process.emit("SIGINT");
        expect(options.init.signal.aborted).toBe(true);
        throw new Error("aborted");
      },
    );

    stubServerApi({ "v1.hosts.$post": create });
    await expect(
      runCommand(["machine", "create", "--provider", "ssh"], register),
    ).rejects.toThrow("process.exit:130");
    expect(collectLogPayloads(vi.mocked(console.error))).toEqual([
      "Error: Stopped following; creation continues. Use omnyo machine remove <host-id> to cancel.",
    ]);
  });

  it.each(["list", "show", "remove"] as const)(
    "can %s a machine before its first enrollment",
    async (command) => {
      const pending = { ...creating, id: "host-pending", name: "pending" };
      const get = vi.fn(async () => pending);
      const remove = vi.fn(async () => undefined);
      stubServerApi({
        "v1.hosts.$get": vi.fn(
          async ({ query }: { query: { includeCreating?: string } }) =>
            query.includeCreating === "true" ? [...hosts, pending] : hosts,
        ),
        "v1.hosts.:id.$get": get,
        "v1.hosts.:id.$delete": remove,
      });

      await runCommand(
        command === "list"
          ? ["machine", "list", "--json"]
          : command === "show"
            ? ["machine", "show", pending.id, "--json"]
            : ["machine", "remove", pending.name, "--yes"],
        register,
      );

      if (command === "remove") {
        expect(remove).toHaveBeenCalledWith({ param: { id: pending.id } });
      } else {
        expect(
          JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
        ).toEqual(command === "list" ? [...hosts, pending] : pending);

        if (command === "show")
          expect(get).toHaveBeenCalledWith({ param: { id: pending.id } });
      }
    },
  );

  it("omnyo machine list marks the server machine in the table", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_120_000);
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.system.config.$get": vi.fn(async () => ({
        primaryHostId: "host-primary",
      })),
    });

    await runCommand(["machine", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "Name         Role    ID            Type        Status        Provider       Last seen\n-----------  ------  ------------  ----------  ------------  -------------  ---------\nworkstation  server  host-primary  persistent  connected     user-enrolled  2m ago\n-----------  ------  ------------  ----------  ------------  -------------  ---------\nlaptop               host-remote   persistent  disconnected  ssh            never",
      "",
    ]);
  });

  it("hides disposable sandboxes from omnyo machine list until --all", async () => {
    const sandbox: Host = {
      ...hosts[0]!,
      id: "host-sandbox",
      name: "sandbox",
      type: "ephemeral",
      machineProviderId: "modal-sandbox",
    };

    const list = vi.fn(async ({ query }: { query: { type?: string } }) =>
      [...hosts, sandbox].filter(
        (host) => query.type === undefined || host.type === query.type,
      ),
    );

    stubServerApi({ "v1.hosts.$get": list });

    await runCommand(["machine", "list", "--json"], register);
    expect(list).toHaveBeenLastCalledWith({
      query: { includeCreating: "true", type: "persistent" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(hosts);

    vi.mocked(console.log).mockClear();
    await runCommand(["machine", "list", "--all", "--json"], register);
    expect(list).toHaveBeenLastCalledWith({
      query: { includeCreating: "true" },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual([...hosts, sandbox]);
  });

  it("omnyo machine retry-update resolves the machine and requests a retry", async () => {
    const retryUpdate = vi.fn(async () => ({ ok: true as const }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.retry-update.$post": retryUpdate,
    });

    await runCommand(["machine", "retry-update", "laptop"], register);

    expect(retryUpdate).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote update retry requested",
    ]);
  });

  it.each([
    ["suspend", "v1.hosts.:id.suspend.$post", "suspended"],
    ["resume", "v1.hosts.:id.resume.$post", "resumed"],
    ["retry-cleanup", "v1.hosts.:id.retry-cleanup.$post", "cleanup retried"],
  ] as const)(
    "omnyo machine %s resolves the machine and invokes the lifecycle action",
    async (command, route, message) => {
      const lifecycleAction = vi.fn(async () =>
        command === "retry-cleanup"
          ? { ok: true as const }
          : {
              ...hosts[1]!,
              lifecycle: {
                ...hosts[1]!.lifecycle,
                phase:
                  command === "suspend"
                    ? ("suspended" as const)
                    : ("active" as const),
              },
            },
      );

      stubServerApi({
        "v1.hosts.$get": vi.fn(async () => hosts),
        [route]: lifecycleAction,
      });

      await runCommand(["machine", command, "laptop"], register);

      expect(lifecycleAction).toHaveBeenCalledWith({
        param: { id: "host-remote" },
      });
      expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
        `Machine host-remote ${message}`,
      ]);
    },
  );

  it("polls the host phase before reporting lifecycle completion", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const suspend = vi.fn(async () => ({
      ...hosts[1]!,
      lifecycle: { ...hosts[1]!.lifecycle, phase: "suspending" as const },
    }));

    const get = vi.fn(async () => ({
      ...hosts[1]!,
      lifecycle: { ...hosts[1]!.lifecycle, phase: "suspended" as const },
    }));

    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.$get": get,
      "v1.hosts.:id.suspend.$post": suspend,
    });

    const command = runCommand(["machine", "suspend", "laptop"], register);
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledOnce());
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    await command;

    expect(get).toHaveBeenCalledWith({ param: { id: "host-remote" } });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote suspended",
    ]);
  });

  it("omnyo machine remove resolves and removes a provider machine", async () => {
    const remove = vi.fn(async () => undefined);
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.$delete": remove,
    });

    await runCommand(["machine", "remove", "laptop", "--yes"], register);

    expect(remove).toHaveBeenCalledWith({ param: { id: "host-remote" } });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote removed",
    ]);
  });
});

describe("machine selection", () => {
  it("resolves an ID before names", () => {
    expect(resolveMachineId(hosts, "host-primary")).toBe("host-primary");
  });

  it("lists matching IDs for an ambiguous name", () => {
    expect(() =>
      resolveMachineId(
        [...hosts, { ...hosts[0], id: "host-other" }],
        "workstation",
      ),
    ).toThrow(
      "Machine name 'workstation' is ambiguous. Matches: workstation (host-primary), workstation (host-other).",
    );
  });

  it("lists available machines for an unknown selector", () => {
    expect(() => resolveMachineId(hosts, "desktop")).toThrow(
      "Machine 'desktop' was not found. Available machines: workstation (host-primary), laptop (host-remote).",
    );
  });

  it("formats future clock skew as just now", () => {
    expect(formatMachineLastSeen(101, 100)).toBe("just now");
  });
});
