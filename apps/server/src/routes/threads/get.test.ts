import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "@omnyo/db";
import { NotificationHub } from "../../ws/hub.js";
import type { Thread } from "@omnyo/domain";
import { registerThreadGetRoute } from "./get.js";

it("returns plugin data in the public thread GET and rejects unknown threads before reading plugins", async () => {
  const db = createConnection(":memory:");
  migrate(db);

  try {
    const host = upsertHost(db, noopNotifier, { name: "Fixture host" });

    const { project } = createProject(db, noopNotifier, {
      name: "Fixture",
      source: { type: "local_path", hostId: host.id, path: "/fixture" },
    });

    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: null,
      providerId: "codex",
    });

    const readThreadBootstrap = vi.fn(
      async (thread: Thread, _signal?: AbortSignal) => [
        {
          pluginId: "card",
          method: "read",
          outcome: {
            ok: true as const,
            result: { threadId: thread.id, headline: "Current stored outcome" },
          },
        },
      ],
    );

    const app = new Hono();
    const api = new Hono();
    registerThreadGetRoute(
      api,
      { db, hub: new NotificationHub() },
      { readThreadBootstrap },
    );
    app.route("/api/v1", api);

    const response = await app.request(
      `/api/v1/threads/${thread.id}?include=experimental_pluginData`,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).experimental_pluginData).toEqual([
      {
        pluginId: "card",
        method: "read",
        outcome: {
          ok: true,
          result: { threadId: thread.id, headline: "Current stored outcome" },
        },
      },
    ]);
    expect(readThreadBootstrap).toHaveBeenCalledExactlyOnceWith(
      thread,
      expect.any(AbortSignal),
    );
    readThreadBootstrap.mockClear();
    expect(
      (
        await app.request(
          "/api/v1/threads/missing?include=experimental_pluginData",
        )
      ).status,
    ).toBe(404);
    expect((await app.request(`/api/v1/threads/${thread.id}`)).status).toBe(
      200,
    );
    expect(readThreadBootstrap).not.toHaveBeenCalled();

    const controller = new AbortController();
    let invocationSignal: AbortSignal | undefined;
    readThreadBootstrap.mockImplementationOnce((_thread, signal) => {
      invocationSignal = signal;

      if (!signal) throw new Error("Bootstrap request must carry cancellation");

      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    });

    const pending = app.request(
      `/api/v1/threads/${thread.id}?include=experimental_pluginData`,
      { signal: controller.signal },
    );

    await vi.waitFor(() =>
      expect(invocationSignal).toBeInstanceOf(AbortSignal),
    );
    expect((await app.request(`/api/v1/threads/${thread.id}`)).status).toBe(
      200,
    );
    controller.abort();
    expect(invocationSignal?.aborted).toBe(true);
    expect((await pending).status).toBe(200);
  } finally {
    db.$client.close();
  }
});
