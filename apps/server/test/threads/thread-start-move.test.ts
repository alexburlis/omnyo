import { getThread, hosts, listEvents } from "@omnyo/db";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import type { PluginHookName } from "@omnyo/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { readPendingThreadStartContext } from "../../src/services/threads/dispatch-attempt.js";
import { isDispatchRequeuedRecently } from "../../src/services/threads/dispatch-hooks.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import {
  moveWaitingThreadStart,
  routeWaitingStartMove,
  TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID,
  type MoveRouteContext,
  type StartMoveTargetProbe,
} from "../../src/services/threads/thread-start-move.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { installFakePersonalWorkspaceProvider } from "../helpers/environment-provider.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHost, seedHostSession } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const ORIGIN = "host-origin";

const TARGET = "host-target";

const PLUGIN = { kind: "plugin", pluginId: "concurrency-limit" } as const;

const readyProbe: StartMoveTargetProbe = {
  agentReady: async () => true,
  modelOffered: async () => true,
};

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

afterEach(() => {
  setPluginHookProvider(undefined);
});

function holdStartsOn(...heldHostIds: string[]): void {
  const registry: HookRegistry = {
    "message.dispatch": [
      {
        pluginId: PLUGIN.pluginId,
        handler: (context) =>
          context.host !== null && heldHostIds.includes(context.host.id)
            ? { action: "wait", reason: "Machine is full" }
            : { action: "proceed" },
      },
    ],
  };

  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

function seedMachines(harness: TestAppHarness): void {
  seedHostSession(harness.deps, { id: ORIGIN, name: "Origin" });
  seedHostSession(harness.deps, { id: TARGET, name: "Target" });
}

function createPersonalChat(
  harness: TestAppHarness,
  machineChoice: "default" | "explicit",
) {
  return createThreadFromRequest(harness.deps, {
    environment: {
      type: "host",
      hostId: ORIGIN,
      workspace: { type: "personal" },
      machineChoice,
    },
    input: textInput("Plan the week"),
    origin: "app",
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    startedOnBehalfOf: null,
  });
}

async function waitingChat(
  harness: TestAppHarness,
  machineChoice: "default" | "explicit" = "default",
) {
  seedMachines(harness);
  installFakePersonalWorkspaceProvider();
  holdStartsOn(ORIGIN, TARGET);

  const thread = await createPersonalChat(harness, machineChoice);
  expect(getThread(harness.db, thread.id)?.status).toBe("pending");

  return thread;
}

describe("moveWaitingThreadStart", () => {
  it("starts a waiting chat on a free machine without waiting out the requeue pacing", async () => {
    await withTestHarness(async (harness) => {
      seedMachines(harness);
      installFakePersonalWorkspaceProvider();
      holdStartsOn(ORIGIN);

      const thread = await createPersonalChat(harness, "default");
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(getThread(harness.db, thread.id)?.status).toBe("pending");
      expect(isDispatchRequeuedRecently(thread.id)).toBe(true);

      const result = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: TARGET,
          expectedHostId: ORIGIN,
          initiator: PLUGIN,
          note: "Started on Target because Origin was full.",
        },
        readyProbe,
      );

      expect(result).toEqual({
        kind: "moved",
        threadId: thread.id,
        fromHostId: ORIGIN,
        toHostId: TARGET,
        environmentProviderId: "personal-workspace",
      });

      await vi.waitFor(
        () => expect(getThread(harness.db, thread.id)?.status).toBe("starting"),
        { timeout: 5_000 },
      );
      expect(
        readThreadProvisionContext(harness.db, thread.id)?.request
          .environmentIntent,
      ).toMatchObject({
        type: "provider",
        machine: { type: "existing", hostId: TARGET },
      });
      expect(
        JSON.stringify(
          listEvents(harness.db, { threadId: thread.id }).filter(
            (event) => event.type === "system/thread-provisioning",
          ),
        ),
      ).toContain("Started on Target because Origin was full.");
    });
  });

  it("keeps a pinned chat away from plugins but lets a person move it", async () => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness, "explicit");

      const byPlugin = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: TARGET,
          expectedHostId: ORIGIN,
          initiator: PLUGIN,
        },
        readyProbe,
      );

      expect(byPlugin).toMatchObject({ kind: "refused", code: "pinned" });

      const byPerson = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: TARGET,
          expectedHostId: ORIGIN,
          initiator: { kind: "person" },
        },
        readyProbe,
      );

      expect(byPerson).toMatchObject({ kind: "moved", toHostId: TARGET });

      const pending = readPendingThreadStartContext(harness.deps, thread.id);
      expect(pending?.machinePinned).toBe(true);
      expect(pending?.environmentIntent).toMatchObject({
        machine: { type: "existing", hostId: TARGET },
      });
    });
  });

  it("records an unpinned default chat as movable by plugins", async () => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness, "default");

      expect(
        readPendingThreadStartContext(harness.deps, thread.id)?.machinePinned,
      ).toBe(false);
    });
  });

  it.each([
    {
      name: "a stale expected machine",
      code: "machine_changed",
      args: { hostId: TARGET, expectedHostId: "host-elsewhere" },
      probe: readyProbe,
    },
    {
      name: "the machine it already waits on",
      code: "same_machine",
      args: { hostId: ORIGIN, expectedHostId: ORIGIN },
      probe: readyProbe,
    },
    {
      name: "an agent that is not ready there",
      code: "agent_not_ready",
      args: { hostId: TARGET, expectedHostId: ORIGIN },
      probe: { ...readyProbe, agentReady: async () => false },
    },
    {
      name: "a model the machine does not offer",
      code: "model_unavailable",
      args: { hostId: TARGET, expectedHostId: ORIGIN },
      probe: { ...readyProbe, modelOffered: async () => false },
    },
  ])("refuses $name", async ({ code, args, probe }) => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness);

      const result = await moveWaitingThreadStart(
        harness.deps,
        { threadId: thread.id, initiator: PLUGIN, ...args },
        probe,
      );

      expect(result).toMatchObject({ kind: "refused", code });
      expect(
        readPendingThreadStartContext(harness.deps, thread.id)
          ?.environmentIntent,
      ).toMatchObject({ machine: { type: "existing", hostId: ORIGIN } });
    });
  });

  it("refuses a machine whose permission ceiling is below the chat's mode", async () => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness);

      harness.db
        .update(hosts)
        .set({ maxPermissionMode: "accept-edits" })
        .where(eq(hosts.id, TARGET))
        .run();

      const result = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: TARGET,
          expectedHostId: ORIGIN,
          initiator: PLUGIN,
        },
        readyProbe,
      );

      expect(result).toMatchObject({
        kind: "refused",
        code: "permission_ceiling",
      });
    });
  });

  it("refuses a disconnected machine", async () => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness);
      seedHost(harness.deps, { id: "host-offline", name: "Offline" });

      const result = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: "host-offline",
          expectedHostId: ORIGIN,
          initiator: PLUGIN,
        },
        readyProbe,
      );

      expect(result).toMatchObject({
        kind: "refused",
        code: "target_unavailable",
      });
    });
  });

  it("refuses a chat that already started", async () => {
    await withTestHarness(async (harness) => {
      seedMachines(harness);
      installFakePersonalWorkspaceProvider();
      holdStartsOn();

      const thread = await createPersonalChat(harness, "default");

      const result = await moveWaitingThreadStart(
        harness.deps,
        {
          threadId: thread.id,
          hostId: TARGET,
          expectedHostId: ORIGIN,
          initiator: PLUGIN,
        },
        readyProbe,
      );

      expect(result).toMatchObject({ kind: "refused", code: "not_waiting" });
    });
  });
});

describe("start-machine routes", () => {
  it("returns refusals as typed results and lists why each machine is ineligible", async () => {
    await withTestHarness(async (harness) => {
      const thread = await waitingChat(harness, "explicit");

      const moved = await harness.app.request(
        `/api/v1/threads/${thread.id}/start-machine`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId: TARGET,
            expectedHostId: ORIGIN,
            initiator: PLUGIN,
          }),
        },
      );

      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({
        kind: "refused",
        code: "pinned",
      });

      const listed = await harness.app.request(
        `/api/v1/threads/${thread.id}/start-machines?pluginId=${PLUGIN.pluginId}`,
      );

      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        originHostId: ORIGIN,
        machines: [
          {
            hostId: TARGET,
            name: "Target",
            eligible: false,
            environmentProviderId: null,
            reason: "This chat is pinned to its machine.",
          },
        ],
      });
    });
  });
});

describe("routeWaitingStartMove", () => {
  const base: MoveRouteContext = {
    inputs: { branch: { kind: "default" } },
    originHostId: ORIGIN,
    originSourcePath: "/Users/developer/projects/app",
    targetHasCheckout: false,
    temporaryCopyAvailable: false,
  };

  it.each([
    {
      name: "a personal workspace keeps its inputs",
      provider: "personal-workspace",
      context: { ...base, inputs: null },
      route: { environmentProviderId: "personal-workspace", inputs: null },
    },
    {
      name: "a worktree moves to a machine with a checkout",
      provider: "git-worktree",
      context: { ...base, targetHasCheckout: true },
      route: {
        environmentProviderId: "git-worktree",
        inputs: { branch: { kind: "default" } },
      },
    },
    {
      name: "a worktree becomes a temporary copy without a checkout",
      provider: "git-worktree",
      context: { ...base, temporaryCopyAvailable: true },
      route: {
        environmentProviderId: TEMPORARY_COPY_ENVIRONMENT_PROVIDER_ID,
        inputs: {
          sourceHostId: ORIGIN,
          sourcePath: "/Users/developer/projects/app",
          worktree: { branch: { kind: "default" } },
        },
      },
    },
  ])("$name", ({ provider, context, route }) => {
    expect(routeWaitingStartMove(provider, context)).toEqual(route);
  });

  it.each([
    {
      name: "an adopted folder",
      provider: "git-worktree",
      context: {
        ...base,
        inputs: { kind: "existing", path: "/Users/developer/w" },
        targetHasCheckout: true,
      },
      code: "not_movable",
    },
    {
      name: "a worktree with nowhere to put its code",
      provider: "git-worktree",
      context: base,
      code: "no_checkout",
    },
    {
      name: "a chat in the machine's own checkout",
      provider: "project-checkout",
      context: base,
      code: "not_movable",
    },
  ])("refuses $name", ({ provider, context, code }) => {
    expect(routeWaitingStartMove(provider, context)).toMatchObject({
      kind: "refused",
      code,
    });
  });
});
