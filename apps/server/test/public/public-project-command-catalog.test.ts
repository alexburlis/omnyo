import { expect, it, vi, type MockInstance } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  commandCatalogResponseSchema,
  commandListResponseSchema,
  systemConfigResponseSchema,
  type CommandCatalogResponse,
  type CommandListResponse,
} from "@omnyo/server-contract";
import type { HostProviderCommand } from "@omnyo/host-daemon-contract";
import {
  deleteProject,
  hostDaemonSessions,
  updateProjectSource,
} from "@omnyo/db";
import { eq } from "drizzle-orm";
import {
  applyEnvironmentLifecycleEvent,
  recordProvisionedEnvironmentWorkspace,
} from "@omnyo/db/internal-environment-lifecycle";
import { COMMAND_CATALOG_RECONCILE_MS } from "../../src/services/threads/project-command-catalogs.js";
import { onDaemonSocketMessage } from "../../src/ws/daemon-protocol.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedEnvironment,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function command(name: string): HostProviderCommand {
  return {
    name,
    source: "command",
    origin: "project",
    description: null,
    argumentHint: null,
  };
}

function hold() {
  let release: () => void = () => undefined;

  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { pending, release: () => release() };
}

interface MetadataFixture {
  commands: HostProviderCommand[];
  calls: number;
  block: Promise<void> | null;
  blockCwd: string | null;
  workspaces: Array<string | null>;
  fail: boolean;
}

async function withCatalog(
  run: (fixture: {
    harness: TestAppHarness;
    projectId: string;
    hostId: string;
    sourceId: string;
    metadata: MetadataFixture;
    changed: MockInstance<TestAppHarness["hub"]["notifySystem"]>;
    signalChange: (
      scopes?: Array<{ cwd: string | null; providerId: string }>,
    ) => void;
    snapshot: (environmentId?: string) => Promise<CommandCatalogResponse>;
    complete: (environmentId?: string) => Promise<CommandListResponse>;
  }) => Promise<void>,
) {
  await withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);

    const { project, source } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/command-catalog",
    });

    const metadata: MetadataFixture = {
      commands: [command("original")],
      calls: 0,
      block: null,
      blockCwd: null,
      workspaces: [],
      fail: false,
    };

    const changed = vi.spyOn(harness.hub, "notifySystem");
    registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: async (request) => {
        if (request.command.type === "plugin.host.call")
          return { ok: true, result: { output: { skills: [], commands: [] } } };

        if (request.command.type !== "host.list_command_metadata")
          throw new Error("Unexpected catalog RPC");
        const commands = metadata.commands;
        metadata.calls++;
        metadata.workspaces.push(request.command.cwd);

        if (
          metadata.block &&
          (metadata.blockCwd === null ||
            metadata.blockCwd === request.command.cwd)
        )
          await metadata.block;

        if (metadata.fail)
          return {
            ok: false,
            errorCode: "metadata_failed",
            errorMessage: "Private worker diagnostic",
          };

        return {
          ok: true,
          result: { commands, projectSkills: [], sharedSkills: [] },
        };
      },
    });
    const base = `/api/v1/projects/${project.id}`;

    try {
      await run({
        harness,
        projectId: project.id,
        hostId: host.id,
        sourceId: source.id,
        metadata,
        changed,
        signalChange: (scopes) =>
          onDaemonSocketMessage(harness.deps, {
            hostId: host.id,
            sessionId: session.id,
            raw: JSON.stringify({
              type: "command-catalog-change",
              ...(scopes === undefined ? {} : { scopes }),
            }),
            socket: { close: vi.fn(), send: vi.fn() },
          }),
        snapshot: async (environmentId) => {
          const response = await harness.app.request(
            `${base}/command-catalog?provider=pi${environmentId === undefined ? "" : `&environmentId=${environmentId}`}`,
          );

          expect(response.status).toBe(200);

          return commandCatalogResponseSchema.parse(await readJson(response));
        },
        complete: async (environmentId) => {
          const response = await harness.app.request(
            `${base}/commands?provider=pi${environmentId === undefined ? "" : `&environmentId=${environmentId}`}`,
          );

          expect(response.status).toBe(200);
          changed.mockClear();

          return commandListResponseSchema.parse(await readJson(response));
        },
      });
    } finally {
      changed.mockRestore();
    }
  });
}

it("returns a command snapshot without waiting for initial worker discovery", async () => {
  await withTestHarness(async (harness) => {
    const { host, session } = seedHostSession(harness.deps);
    seedPrimaryHost(harness.deps, host.id);

    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/command-catalog",
    });

    let release: () => void = () => undefined;

    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const rpc = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: async (request) => {
        if (request.command.type === "plugin.host.call")
          return { ok: true, result: { output: { skills: [], commands: [] } } };
        await pending;

        return {
          ok: true,
          result: { commands: [], projectSkills: [], sharedSkills: [] },
        };
      },
    });

    try {
      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/command-catalog?provider=pi`,
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        state: "preparing",
        commands: expect.arrayContaining([
          expect.objectContaining({ name: "clear", origin: "builtin" }),
        ]),
      });
      expect(
        rpc.requests.filter(
          (request) => request.command.type === "host.list_command_metadata",
        ).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      release();
    }
  });
});

it("shares effective workspace routing and isolates a different environment", async () => {
  await withCatalog(
    async ({ harness, projectId, hostId, metadata, snapshot, complete }) => {
      await complete();

      const same = seedEnvironment(harness.deps, {
        projectId,
        hostId,
        path: "/tmp/command-catalog",
      });

      const sameResponse = await harness.app.request(
        `/api/v1/projects/${projectId}/command-catalog?provider=pi&environmentId=${same.id}`,
      );

      expect(
        commandCatalogResponseSchema.parse(await readJson(sameResponse)).state,
      ).toBe("ready");
      expect(metadata.calls).toBe(1);

      metadata.commands = [command("other-environment")];

      const other = seedEnvironment(harness.deps, {
        projectId,
        hostId,
        path: "/tmp/other-command-catalog",
      });

      const otherResponse = await harness.app.request(
        `/api/v1/projects/${projectId}/commands?provider=pi&environmentId=${other.id}`,
      );

      expect(otherResponse.status).toBe(200);
      expect(await readJson(otherResponse)).toMatchObject({
        commands: expect.arrayContaining([
          expect.objectContaining({ name: "other-environment" }),
        ]),
      });
      expect((await snapshot()).commands.map(({ name }) => name)).toContain(
        "original",
      );
      expect((await snapshot()).commands.map(({ name }) => name)).not.toContain(
        "other-environment",
      );
    },
  );
});

it("refreshes from a daemon change without a reader and keeps ready rows during held discovery", async () => {
  await withCatalog(
    async ({ metadata, changed, signalChange, snapshot, complete }) => {
      await complete();
      let release: () => void = () => undefined;
      metadata.block = new Promise<void>((resolve) => {
        release = resolve;
      });
      metadata.commands = [command("updated")];

      try {
        signalChange();
        await expect.poll(() => metadata.calls).toBe(2);
        const held = await snapshot();
        expect(held.state).toBe("ready");
        expect(held.commands.map(({ name }) => name)).toContain("original");
        expect(metadata.calls).toBe(2);
        release();
        await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
        expect((await snapshot()).commands.map(({ name }) => name)).toContain(
          "updated",
        );
        expect(metadata.calls).toBe(2);
      } finally {
        release();
      }
    },
  );
});

it("refreshes only matching host, workspace and provider catalogs from scoped daemon changes", async () => {
  await withCatalog(
    async ({
      harness,
      projectId,
      hostId,
      metadata,
      signalChange,
      snapshot,
      complete,
    }) => {
      await complete();

      const unrelated = seedEnvironment(harness.deps, {
        projectId,
        hostId,
        path: "/tmp/unrelated-command-catalog",
      });

      await complete(unrelated.id);
      expect(metadata.calls).toBe(2);
      metadata.commands = [command("scoped-update")];

      signalChange([
        { cwd: "/tmp/command-catalog", providerId: "another-provider" },
      ]);
      signalChange([{ cwd: "/tmp/not-a-catalog", providerId: "pi" }]);
      const otherHost = seedHostSession(harness.deps);
      onDaemonSocketMessage(harness.deps, {
        hostId: otherHost.host.id,
        sessionId: otherHost.session.id,
        raw: JSON.stringify({
          type: "command-catalog-change",
          scopes: [{ cwd: "/tmp/command-catalog", providerId: "pi" }],
        }),
        socket: { close: vi.fn(), send: vi.fn() },
      });
      await setImmediate();
      expect(metadata.calls).toBe(2);

      signalChange([{ cwd: "/tmp/command-catalog", providerId: "pi" }]);
      await expect
        .poll(async () => (await snapshot()).commands.map(({ name }) => name))
        .toContain("scoped-update");
      expect(metadata.calls).toBe(3);
      expect(
        (await snapshot(unrelated.id)).commands.map(({ name }) => name),
      ).toContain("original");
      expect(metadata.workspaces.slice(2)).toEqual(["/tmp/command-catalog"]);

      metadata.commands = [command("legacy-update")];
      signalChange();
      await expect
        .poll(async () => (await snapshot()).commands.map(({ name }) => name))
        .toContain("legacy-update");
      await expect
        .poll(async () =>
          (await snapshot(unrelated.id)).commands.map(({ name }) => name),
        )
        .toContain("legacy-update");
      expect(metadata.calls).toBe(5);
    },
  );
});

it("synchronizes retained catalog scopes on replacement and reconnect without legacy messages", async () => {
  await withCatalog(
    async ({ harness, hostId, projectId, sourceId, complete }) => {
      await complete();
      const sent = vi.spyOn(harness.hub, "sendDaemonSessionMessage");

      const retained = () =>
        sent.mock.calls.flatMap(([, message]) =>
          message.type === "command-catalog-retain" ? [message.scopes] : [],
        );

      try {
        updateProjectSource(harness.deps.db, harness.hub, sourceId, {
          path: "/tmp/replacement-command-catalog",
        });
        expect(retained()).toContainEqual([]);
        await complete();
        sent.mockClear();
        harness.hub.notifyHost(hostId, ["host-connected"]);
        expect(retained()).toContainEqual([
          { cwd: "/tmp/replacement-command-catalog", providerId: "pi" },
        ]);

        const sessionId = harness.hub.getDaemonSessionIdForHost(hostId);

        if (sessionId === null) throw new Error("Missing fixture session");
        harness.deps.db
          .update(hostDaemonSessions)
          .set({ protocolVersion: 260 })
          .where(eq(hostDaemonSessions.id, sessionId))
          .run();
        sent.mockClear();
        harness.hub.notifyHost(hostId, ["host-connected"]);
        expect(retained()).toEqual([]);

        harness.deps.db
          .update(hostDaemonSessions)
          .set({ protocolVersion: 261 })
          .where(eq(hostDaemonSessions.id, sessionId))
          .run();
        sent.mockClear();
        expect(deleteProject(harness.deps.db, harness.hub, projectId)).toBe(
          true,
        );
        expect(retained()).toContainEqual([]);
      } finally {
        sent.mockRestore();
      }
    },
  );
});

it("keeps usable commands with a safe visible refresh failure", async () => {
  await withCatalog(
    async ({ metadata, changed, signalChange, snapshot, complete }) => {
      await complete();
      metadata.fail = true;
      signalChange();
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
      const failed = await snapshot();
      expect(failed).toMatchObject({
        state: "failed",
        error: {
          code: "command_catalog_failed",
          message: "Failed to refresh commands",
        },
      });
      expect(failed.commands.map(({ name }) => name)).toContain("original");
      expect(JSON.stringify(failed)).not.toContain("Private worker diagnostic");
    },
  );
});

it("does not rebroadcast an unchanged refresh failure to clients", async () => {
  await withCatalog(
    async ({
      harness,
      projectId,
      metadata,
      changed,
      signalChange,
      snapshot,
      complete,
    }) => {
      const broadcasts = () =>
        changed.mock.calls.filter(([changes]) =>
          changes.includes("command-catalog-changed"),
        ).length;

      await complete();
      metadata.fail = true;
      signalChange();
      await expect.poll(async () => (await snapshot()).state).toBe("failed");
      await expect.poll(broadcasts).toBeGreaterThan(0);
      changed.mockClear();

      const failedCalls = metadata.calls;
      await harness.app.request(
        `/api/v1/projects/${projectId}/commands?provider=pi`,
      );
      expect(metadata.calls).toBeGreaterThan(failedCalls);
      expect((await snapshot()).state).toBe("failed");
      expect(broadcasts()).toBe(0);

      metadata.fail = false;
      signalChange();
      await expect.poll(async () => (await snapshot()).state).toBe("ready");
      expect(broadcasts()).toBeGreaterThan(0);
    },
  );
});

it("publishes server-owned defaults in bootstrap before worker discovery", async () => {
  await withCatalog(async ({ harness, metadata, snapshot }) => {
    const response = await harness.app.request("/api/v1/system/config");
    expect(response.status).toBe(200);
    expect(
      systemConfigResponseSchema.parse(await readJson(response)),
    ).toMatchObject({
      commandDefaultsByProvider: {
        pi: expect.arrayContaining([
          expect.objectContaining({ name: "clear", origin: "builtin" }),
        ]),
      },
    });
    expect(metadata.calls).toBe(0);
    const prepared = await snapshot();
    expect(prepared.commands).toContainEqual(
      expect.objectContaining({ name: "clear", origin: "builtin" }),
    );
  });
});

it("maintains registered provider catalogs from contribution events", async () => {
  await withCatalog(
    async ({ harness, metadata, changed, snapshot, complete }) => {
      await complete();
      metadata.commands = [command("new-contribution")];
      harness.hub.notifySystem(["provider-registrations-changed"]);
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(1);
      expect((await snapshot()).commands.map(({ name }) => name)).toContain(
        "new-contribution",
      );
      expect(metadata.calls).toBe(2);
    },
  );
});

it("coalesces benign notifications while coherent discovery is pending", async () => {
  await withCatalog(async ({ metadata, signalChange, snapshot, complete }) => {
    await complete();

    const first = hold();
    const followup = hold();
    metadata.block = first.pending;
    let completed = false;
    let result: Promise<CommandListResponse> | null = null;

    try {
      signalChange();
      await expect.poll(() => metadata.calls).toBe(2);
      metadata.block = followup.pending;

      for (let index = 0; index < 20; index++) signalChange();
      result = complete().then((value) => {
        completed = true;

        return value;
      });
      await setImmediate();
      expect(completed).toBe(false);
      first.release();
      await expect.poll(() => completed).toBe(true);
      await expect.poll(() => metadata.calls).toBe(3);
      const current = await snapshot();
      expect(current.state).toBe("ready");
      expect(current.commands.map(({ name }) => name)).toContain("original");
      expect((await result).commands.map(({ name }) => name)).toContain(
        "original",
      );
    } finally {
      first.release();
      followup.release();

      if (result) await result;
    }
  });
});

it("refreshes an edit received during a pending coherent discovery", async () => {
  await withCatalog(
    async ({ metadata, changed, signalChange, snapshot, complete }) => {
      await complete();

      const first = hold();
      const followup = hold();
      metadata.block = first.pending;
      let completed = false;
      let result: Promise<CommandListResponse> | null = null;

      try {
        signalChange();
        await expect.poll(() => metadata.calls).toBe(2);
        metadata.commands = [command("edited-while-pending")];
        metadata.block = followup.pending;

        for (let index = 0; index < 20; index++) signalChange();
        result = complete().then((value) => {
          completed = true;

          return value;
        });
        first.release();
        await expect.poll(() => completed).toBe(true);
        await expect.poll(() => metadata.calls).toBe(3);
        expect((await snapshot()).commands.map(({ name }) => name)).toContain(
          "original",
        );
        followup.release();
        await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
        await setImmediate();
        expect((await snapshot()).commands.map(({ name }) => name)).toContain(
          "edited-while-pending",
        );
        expect(metadata.calls).toBe(3);
      } finally {
        first.release();
        followup.release();

        if (result) await result;
      }
    },
  );
});

it("rejects metadata captured before an actual provider binding change", async () => {
  await withCatalog(
    async ({
      harness,
      metadata,
      changed,
      signalChange,
      snapshot,
      complete,
    }) => {
      await complete();
      let release: () => void = () => undefined;
      metadata.block = new Promise<void>((resolve) => {
        release = resolve;
      });
      metadata.commands = [command("obsolete")];
      let registered: { dispose(): void } | null = null;

      try {
        signalChange();
        await expect.poll(() => metadata.calls).toBe(2);
        metadata.commands = [command("latest")];
        const registration = harness.deps.providerRegistry.get("pi");

        if (registration === null) throw new Error("Missing fixture provider");
        registered = harness.deps.providerRegistry.register({
          ...registration,
          pluginId: "catalog-binding-change",
          info: {
            ...registration.info,
            id: "catalog-binding-change",
            pluginId: "catalog-binding-change",
          },
        });
        harness.hub.notifySystem(["provider-registrations-changed"]);
        release();
        await expect
          .poll(
            () =>
              changed.mock.calls.filter(([changes]) =>
                changes.includes("command-catalog-changed"),
              ).length,
          )
          .toBeGreaterThan(0);
        const current = await snapshot();
        expect(current.commands.map(({ name }) => name)).toContain("latest");
        expect(current.commands.map(({ name }) => name)).not.toContain(
          "obsolete",
        );
        expect(metadata.calls).toBe(3);
      } finally {
        release();
        registered?.dispose();
      }
    },
  );
});

it("rebinds a creating environment shared with its fallback catalog before another read", async () => {
  await withCatalog(
    async ({
      harness,
      projectId,
      hostId,
      metadata,
      changed,
      snapshot,
      complete,
    }) => {
      await complete();

      const environment = seedEnvironment(harness.deps, {
        projectId,
        hostId,
        status: "creating",
        path: null,
      });

      await complete(environment.id);

      const first = hold();
      metadata.commands = [command("obsolete-fallback")];
      metadata.block = first.pending;
      metadata.blockCwd = "/tmp/command-catalog";

      const old = harness.app.request(
        `/api/v1/projects/${projectId}/commands?provider=pi&environmentId=${environment.id}`,
      );

      try {
        await expect.poll(() => metadata.calls).toBe(3);
        metadata.commands = [command("actual-environment")];
        expect(
          applyEnvironmentLifecycleEvent(harness.deps.db, harness.hub, {
            environmentId: environment.id,
            event: { type: "provision.requested" },
          }).applied,
        ).toBe(true);
        recordProvisionedEnvironmentWorkspace(
          harness.deps.db,
          harness.hub,
          environment.id,
          {
            path: "/tmp/actual-command-environment",
            isGitRepo: false,
            isWorktree: false,
            branchName: null,
            defaultBranch: null,
          },
        );
        expect(metadata.calls).toBe(3);
        expect(
          applyEnvironmentLifecycleEvent(harness.deps.db, harness.hub, {
            environmentId: environment.id,
            event: { type: "provision.succeeded" },
          }).applied,
        ).toBe(true);
        await expect
          .poll(() =>
            metadata.workspaces.includes("/tmp/actual-command-environment"),
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              changed.mock.calls.filter(([changes]) =>
                changes.includes("command-catalog-changed"),
              ).length,
          )
          .toBeGreaterThan(0);
        const current = await snapshot(environment.id);
        expect(current.state).toBe("ready");
        expect(current.commands.map(({ name }) => name)).toContain(
          "actual-environment",
        );
        expect(current.commands.map(({ name }) => name)).not.toContain(
          "obsolete-fallback",
        );
        const calls = metadata.calls;
        recordProvisionedEnvironmentWorkspace(
          harness.deps.db,
          harness.hub,
          environment.id,
          {
            path: "/tmp/actual-command-environment",
            isGitRepo: true,
            isWorktree: false,
            branchName: "main",
            defaultBranch: "main",
          },
        );
        await setImmediate();
        expect(metadata.calls).toBe(calls);
        expect((await snapshot(environment.id)).state).toBe("ready");
        first.release();
        expect((await old).status).toBe(409);
        expect(
          (await snapshot(environment.id)).commands.map(({ name }) => name),
        ).toContain("actual-environment");
      } finally {
        first.release();
        await old;
      }
    },
  );
});

it("rebinds a same-host source replacement and rejects its late old completion", async () => {
  await withCatalog(
    async ({
      harness,
      projectId,
      sourceId,
      metadata,
      changed,
      snapshot,
      complete,
    }) => {
      await complete();

      const first = hold();
      metadata.commands = [command("obsolete-source")];
      metadata.block = first.pending;
      metadata.blockCwd = "/tmp/command-catalog";

      const old = harness.app.request(
        `/api/v1/projects/${projectId}/commands?provider=pi`,
      );

      try {
        await expect.poll(() => metadata.calls).toBe(2);
        metadata.commands = [command("replacement-source")];
        expect(
          updateProjectSource(harness.deps.db, harness.hub, sourceId, {
            path: "/tmp/replacement-command-source",
          }),
        ).not.toBeNull();
        await expect
          .poll(() =>
            metadata.workspaces.includes("/tmp/replacement-command-source"),
          )
          .toBe(true);
        await expect
          .poll(
            () =>
              changed.mock.calls.filter(([changes]) =>
                changes.includes("command-catalog-changed"),
              ).length,
          )
          .toBeGreaterThan(0);
        const current = await snapshot();
        expect(current.state).toBe("ready");
        expect(current.commands.map(({ name }) => name)).toContain(
          "replacement-source",
        );
        expect(current.commands.map(({ name }) => name)).not.toContain(
          "obsolete-source",
        );
        first.release();
        expect((await old).status).toBe(409);
        expect((await snapshot()).commands.map(({ name }) => name)).toContain(
          "replacement-source",
        );
      } finally {
        first.release();
        await old;
      }
    },
  );
});

it("reconciles missed native events independently of catalog reads", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  try {
    await withCatalog(async ({ metadata, changed, snapshot, complete }) => {
      await complete();
      metadata.commands = [command("missed-event")];
      await vi.advanceTimersByTimeAsync(COMMAND_CATALOG_RECONCILE_MS);
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
      expect((await snapshot()).commands.map(({ name }) => name)).toContain(
        "missed-event",
      );
      expect(metadata.calls).toBe(2);
    });
  } finally {
    vi.useRealTimers();
  }
});
