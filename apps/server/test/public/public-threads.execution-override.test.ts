import { describe, expect, it } from "vitest";
import { getQueuedThreadMessage, getThreadExecutionOverride } from "@omnyo/db";
import {
  registerHostRpcResponder,
  registerProviderHostRpcResponder,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function stubProviderCatalog(
  harness: TestAppHarness,
  hostId: string,
  sessionId: string,
  providerId: string,
  model: string,
): void {
  registerProviderHostRpcResponder(harness, {
    hostId,
    sessionId,
    modelsByProviderId: {
      [providerId]: {
        models: [
          {
            id: model,
            model,
            displayName: model,
            description: "",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "xhigh", description: "" },
              { reasoningEffort: "max", description: "" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
        selectedOnlyModels: [],
      },
    },
  });
}

function seedProviderThread(
  harness: TestAppHarness,
  providerId = "claude-code",
  status: "idle" | "active" = "idle",
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-override-${providerId}`,
  });

  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
    status,
  });

  return { host, session, thread };
}

function patchThread(harness: TestAppHarness, threadId: string, body: unknown) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /threads/:id execution override", () => {
  for (const provider of [
    { id: "codex", model: "gpt-5.6-sol" },
    { id: "claude-code", model: "claude-opus-4-8" },
    { id: "pi", model: "openai/gpt-5.4" },
    { id: "acp-cursor", model: "gpt-5.3-codex" },
  ]) {
    it(`persists a catalog-scoped model + reasoning override for ${provider.id}`, async () => {
      await withTestHarness(async (harness) => {
        const { host, session, thread } = seedProviderThread(
          harness,
          provider.id,
        );

        stubProviderCatalog(
          harness,
          host.id,
          session.id,
          provider.id,
          provider.model,
        );

        const response = await patchThread(harness, thread.id, {
          model: provider.model,
          reasoningLevel: "high",
        });

        expect(response.status).toBe(200);
        expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
          modelOverride: provider.model,
          reasoningLevelOverride: "high",
        });
      });
    });
  }

  it("rejects a model that is not in the provider's catalog", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-4-8",
      );

      const response = await patchThread(harness, thread.id, {
        model: "gpt-5",
      });

      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(JSON.stringify(body)).toContain(
        "not available in this thread's claude-code model catalog",
      );
      expect(getThreadExecutionOverride(harness.db, thread.id)).toEqual({
        modelOverride: null,
        reasoningLevelOverride: null,
      });
    });
  });
});

describe("PATCH /threads/:id/queued-messages/:queuedMessageId execution", () => {
  it("saves a model and reasoning change made while editing a queued message", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedProviderThread(harness);
      stubProviderCatalog(
        harness,
        host.id,
        session.id,
        "claude-code",
        "claude-opus-4-8",
      );

      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "queued", mentions: [] }],
        model: "claude-sonnet-4-6",
        reasoningLevel: "medium",
        waitingOn: { kind: "thread-busy" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queued.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: queued.updatedAt,
            input: [{ type: "text", text: "edited", mentions: [] }],
            model: "claude-opus-4-8",
            reasoningLevel: "high",
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        model: "claude-opus-4-8",
        reasoningLevel: "high",
      });
      expect(getQueuedThreadMessage(harness.db, queued.id)).toMatchObject({
        model: "claude-opus-4-8",
        reasoningLevel: "high",
      });
    });
  });
});

it("persists an idle session speed reset through the shared update API", async () => {
  await withTestHarness(async (harness) => {
    const { host, session, thread } = seedProviderThread(harness, "codex");
    stubProviderCatalog(harness, host.id, session.id, "codex", "gpt-5.6-sol");

    const response = await patchThread(harness, thread.id, {
      model: "gpt-5.6-sol",
      serviceTier: "default",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ serviceTier: "default" });
    const fetched = await harness.app.request(`/api/v1/threads/${thread.id}`);
    expect(await readJson(fetched)).toMatchObject({ serviceTier: "default" });
  });
});

it("sends an active session speed change to its owning host before confirming it", async () => {
  await withTestHarness(async (harness) => {
    const { host, session, thread } = seedProviderThread(
      harness,
      "codex",
      "active",
    );

    stubProviderCatalog(harness, host.id, session.id, "codex", "gpt-5.6-sol");
    expect(
      (await patchThread(harness, thread.id, { model: "gpt-5.6-sol" })).status,
    ).toBe(200);

    const responder = registerHostRpcResponder(harness, {
      hostId: host.id,
      sessionId: session.id,
      handle: (request) => {
        if (request.command.type !== "thread.speed.set")
          throw new Error(`Unexpected command ${request.command.type}`);

        expect(request.command).toMatchObject({
          threadId: thread.id,
          serviceTier: "default",
        });

        return { ok: true, result: { ok: true } };
      },
    });

    const response = await patchThread(harness, thread.id, {
      serviceTier: "default",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(responder.requests.map((request) => request.command.type)).toEqual([
      "thread.speed.set",
    ]);
    expect(await readJson(response)).toMatchObject({ serviceTier: "default" });
  });
});
