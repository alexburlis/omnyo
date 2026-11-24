import { getThread, listEvents, listQueuedThreadMessages } from "@omnyo/db";
import { describe, expect, it } from "vitest";
import {
  isHostUpdateDraining,
  isServerUpdateDraining,
  reserveHostUpdateDrain,
  setServerUpdateDraining,
} from "../../src/services/system/server-update-drain.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const SERVER_VERSION = "1.0.50";

function fixture(harness: TestAppHarness, id: string, version: string) {
  const result = seedThreadFixture(harness, {
    session: { id },
    thread: { status: "idle" },
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: result.thread.id,
    environmentId: result.environment.id,
    providerThreadId: `provider-${id}`,
  });
  harness.hub.recordDaemonSessionRuntimeUpdate(result.session.id, {
    runtimeVersion: version,
    automaticUpdates: true,
  });

  return result;
}

function send(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "start",
      input: [{ type: "text", text: "A new task" }],
    }),
  });
}

describe("worker update admission", () => {
  it("dispatches immediately on an older accepted automatic worker", async () => {
    await withTestHarness({ appVersion: SERVER_VERSION }, async (harness) => {
      const behind = fixture(harness, "host-behind-ready", "1.0.49");

      expect(isHostUpdateDraining(harness.deps, behind.host.id)).toBe(false);
      const response = await send(harness, behind.thread.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ delivery: "sent" });
      expect(getThread(harness.db, behind.thread.id)?.status).toBe("active");
      expect(listQueuedThreadMessages(harness.db, behind.thread.id)).toEqual(
        [],
      );
    });
  });

  it("dispatches an older worker's queued message once when its explicit drain ends", async () => {
    await withTestHarness({ appVersion: SERVER_VERSION }, async (harness) => {
      const behind = fixture(harness, "host-behind", "1.0.49");
      const ready = fixture(harness, "host-ready", SERVER_VERSION);
      const release = reserveHostUpdateDrain(harness.db, behind.host.id);

      expect(isHostUpdateDraining(harness.deps, behind.host.id)).toBe(true);
      expect(isHostUpdateDraining(harness.deps, ready.host.id)).toBe(false);
      expect(isServerUpdateDraining(harness.deps)).toBe(false);

      const requestsBefore = listEvents(harness.db, {
        threadId: behind.thread.id,
      }).filter((event) => event.type === "client/turn/requested").length;

      const held = await send(harness, behind.thread.id);
      expect(held.status).toBe(200);
      expect(await held.json()).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "server-update" } },
      });

      const queuedId = listQueuedThreadMessages(harness.db, behind.thread.id)[0]
        ?.id;

      expect(queuedId).toBeDefined();
      const running = await send(harness, ready.thread.id);
      expect(running.status).toBe(200);
      expect(await running.json()).toMatchObject({ delivery: "sent" });
      expect(getThread(harness.db, ready.thread.id)?.status).toBe("active");

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(getThread(harness.db, behind.thread.id)?.status).toBe("idle");
      const waiting = listQueuedThreadMessages(harness.db, behind.thread.id);

      expect(waiting).toHaveLength(1);
      expect(waiting.map((row) => row.id)).toEqual([queuedId]);
      release();
      expect(isHostUpdateDraining(harness.deps, behind.host.id)).toBe(false);
      expect(harness.hub.getDaemonSessionIdForHost(behind.host.id)).toBe(
        behind.session.id,
      );
      expect(
        harness.hub.getDaemonSessionRuntimeVersion(behind.session.id),
      ).toBe("1.0.49");
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(getThread(harness.db, behind.thread.id)?.status).toBe("active");
      expect(listQueuedThreadMessages(harness.db, behind.thread.id)).toEqual(
        [],
      );
      expect(
        listEvents(harness.db, { threadId: behind.thread.id }).filter(
          (event) => event.type === "client/turn/requested",
        ),
      ).toHaveLength(requestsBefore + 1);
    });
  });

  it.each([
    { version: SERVER_VERSION, automaticUpdates: true },
    { version: "1.0.51", automaticUpdates: true },
    { version: "1.0.49", automaticUpdates: false },
    { version: null, automaticUpdates: true },
    { version: "development", automaticUpdates: true },
  ])(
    "does not hold a worker reporting $version with automatic updates $automaticUpdates",
    async ({ version, automaticUpdates }) => {
      await withTestHarness({ appVersion: SERVER_VERSION }, async (harness) => {
        const host = fixture(harness, "host-no-runtime-wait", SERVER_VERSION);
        harness.hub.recordDaemonSessionRuntimeUpdate(host.session.id, {
          runtimeVersion: version,
          automaticUpdates,
        });
        expect(isHostUpdateDraining(harness.deps, host.host.id)).toBe(false);
        expect((await send(harness, host.thread.id)).status).toBe(200);
        expect(getThread(harness.db, host.thread.id)?.status).toBe("active");
      });
    },
  );

  it("drops a disconnected session's runtime hold without releasing an explicit host hold", async () => {
    await withTestHarness({ appVersion: SERVER_VERSION }, async (harness) => {
      const host = fixture(harness, "host-disconnected", "1.0.49");
      const release = reserveHostUpdateDrain(harness.db, host.host.id);
      harness.hub.unregisterDaemon(host.session.id);
      expect(isHostUpdateDraining(harness.deps, host.host.id)).toBe(true);
      release();
      expect(isHostUpdateDraining(harness.deps, host.host.id)).toBe(false);
      expect(isServerUpdateDraining(harness.deps)).toBe(false);
    });
  });

  it("keeps coordinator restart admission separate from current worker sessions", async () => {
    await withTestHarness({ appVersion: SERVER_VERSION }, async (harness) => {
      const host = fixture(harness, "host-coordinator-restart", SERVER_VERSION);
      setServerUpdateDraining(harness.db, true);
      expect(isServerUpdateDraining(harness.deps, host.host.id)).toBe(true);
      setServerUpdateDraining(harness.db, false);
      expect(isServerUpdateDraining(harness.deps, host.host.id)).toBe(false);
    });
  });
});
