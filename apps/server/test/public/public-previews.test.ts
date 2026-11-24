import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { previewBindingSchema } from "@omnyo/server-contract";
import { getManagedPreview } from "@omnyo/db";

describe("managed preview registration", () => {
  let harness: TestAppHarness;
  let threadId: string;
  let fixture: ReturnType<typeof seedThreadFixture>;
  beforeEach(async () => {
    harness = await createTestAppHarness({ seedFirstPartyProviders: false });
    fixture = seedThreadFixture(harness);
    threadId = fixture.thread.id;
  });
  afterEach(async () => harness.cleanup());

  async function register(overrides: Record<string, unknown> = {}) {
    return harness.app.request("/api/v1/previews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        url: "http://localhost:4399/compare/superwhisper?debug=1#ready",
        argv: ["node", "server.mjs"],
        ...overrides,
      }),
    });
  }

  it("persists an exact recipe once and returns only safe routing metadata", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const body = previewBindingSchema.parse(await res.json());
    expect(body.remoteUrl).toBe(
      `/preview/${body.id}/compare/superwhisper?debug=1#ready`,
    );
    expect(body).not.toHaveProperty("argv");
    expect(getManagedPreview(harness.db, body.id)?.argv).toEqual([
      "node",
      "server.mjs",
    ]);
    expect(getManagedPreview(harness.db, body.id)?.cwd).toBe(
      "/tmp/test-environment",
    );

    const repeated = previewBindingSchema.parse(
      await (await register()).json(),
    );

    expect(repeated.id).toBe(body.id);
    expect((await register({ argv: ["node", "different.mjs"] })).status).toBe(
      409,
    );
  });
  it("resolves the command directory with the owning Windows workspace paths", async () => {
    threadId = seedThreadFixture(harness, {
      session: { platform: "win32" },
      environment: { path: "C:\\workspaces\\preview" },
    }).thread.id;
    const response = await register({ cwd: "web" });
    expect(response.status).toBe(201);
    const binding = previewBindingSchema.parse(await response.json());
    expect(getManagedPreview(harness.db, binding.id)?.cwd).toBe(
      "C:\\workspaces\\preview\\web",
    );
    expect((await register({ cwd: "C:\\elsewhere" })).status).toBe(400);
  });
  it("rejects arbitrary destinations, credentials and paths outside the owning workspace", async () => {
    for (const url of [
      "http://example.com:4399/",
      "http://localhost.evil:4399/",
      "http://user:secret@localhost:4399/",
      "file:///tmp/a",
    ])
      expect((await register({ url })).status).toBe(400);
    expect((await register({ cwd: "/elsewhere" })).status).toBe(400);
    expect((await register({ readinessPath: "//example.com/a" })).status).toBe(
      400,
    );
  });
  it("rejects cross-origin registration and arbitrary restart shell fields", async () => {
    const response = await harness.app.request("/api/v1/previews", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({
        threadId,
        url: "http://localhost:4399/",
        argv: ["node", "server.mjs"],
      }),
    });

    expect(response.status).toBe(403);
    const binding = previewBindingSchema.parse(await (await register()).json());

    const restart = await harness.app.request(
      `/api/v1/previews/${binding.id}/restart`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "test-request",
          command: "touch /tmp/unsafe",
        }),
      },
    );

    expect(restart.status).toBe(400);
  });
  it("checks scoped access before answering opaque-origin preview preflights", async () => {
    const response = await harness.app.request(
      "/preview-content/prv_unregistered/unknown/asset",
      {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "GET",
          "access-control-request-headers": "rsc",
        },
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("removes a recipe only after its connected machine reports no live run", async () => {
    const binding = previewBindingSchema.parse(await (await register()).json());

    const remove = () =>
      harness.app.request(`/api/v1/previews/${binding.id}`, {
        method: "DELETE",
      });

    const offline = await remove();
    expect(offline.status).toBeGreaterThanOrEqual(400);
    expect(getManagedPreview(harness.db, binding.id)).toBeDefined();

    let observed = {
      state: "online" as "online" | "error" | "stopped",
      runId: "run-1" as string | null,
    };

    const responder = registerHostRpcResponder(harness, {
      hostId: fixture.host.id,
      sessionId: fixture.session.id,
      handle(request) {
        if (request.command.type !== "host.preview.status")
          return { ok: false, errorCode: "unexpected", errorMessage: "" };

        return {
          ok: true,
          result: { ...observed, checkedAt: 1, detail: null },
        };
      },
    });

    try {
      const running = await remove();
      expect(running.status).toBe(409);
      expect(await running.json()).toMatchObject({ code: "preview_running" });
      observed = { state: "error", runId: "run-1" };
      expect((await remove()).status).toBe(409);
      expect(getManagedPreview(harness.db, binding.id)).toBeDefined();

      observed = { state: "stopped", runId: "run-1" };
      const removed = await remove();
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ ok: true });
      expect(getManagedPreview(harness.db, binding.id)).toBeUndefined();
      expect((await remove()).status).toBe(404);
      expect(
        responder.requests.every(
          (request) => request.command.type === "host.preview.status",
        ),
      ).toBe(true);
    } finally {
      responder.unregister();
    }
  });
});
