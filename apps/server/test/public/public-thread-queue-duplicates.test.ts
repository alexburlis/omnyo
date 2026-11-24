import { listQueuedThreadMessages } from "@omnyo/db";
import { sendMessageResponseSchema } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { setServerUpdateDraining } from "../../src/services/system/server-update-drain.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const queuedMessageIdResponseSchema = z.object({ id: z.string() });

function textInput(text: string) {
  return [{ type: "text" as const, text, mentions: [] }];
}

function seedConnectedThread(
  harness: TestAppHarness,
  status: "idle" | "active",
): string {
  const { host } = seedHostSession(harness.deps, {
    id: `host-queue-duplicates-${status}`,
    name: "M5",
  });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/queue-duplicates-${status}`,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status,
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-queue-duplicates-${status}`,
  });

  if (status === "active") {
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `provider-queue-duplicates-${status}`,
      threadId: thread.id,
      turnId: "turn-current",
    });
  }

  return thread.id;
}

async function send(harness: TestAppHarness, threadId: string, text: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: textInput(text),
        mode: "auto",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    },
  );

  expect(response.status).toBe(200);

  return sendMessageResponseSchema.parse(await readJson(response));
}

async function createQueuedMessage(
  harness: TestAppHarness,
  threadId: string,
  text: string,
) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/queued-messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: textInput(text),
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    },
  );

  expect(response.status).toBe(201);

  return queuedMessageIdResponseSchema.parse(await readJson(response)).id;
}

function queuedTexts(harness: TestAppHarness, threadId: string): string[] {
  return listQueuedThreadMessages(harness.db, threadId).map((row) =>
    z
      .array(z.object({ text: z.string() }))
      .parse(JSON.parse(row.content))
      .map((part) => part.text)
      .join(""),
  );
}

describe("duplicate queued messages", () => {
  it("keeps one queued copy when the same message is sent repeatedly while the update drains", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "idle");
      setServerUpdateDraining(harness.db, true);

      const first = await send(harness, threadId, "Finish the release");
      const second = await send(harness, threadId, "Finish the release");
      const third = await send(harness, threadId, "Finish the release");

      if (first.delivery !== "queued") throw new Error("first send queued");
      expect(second).toMatchObject({
        delivery: "queued",
        queuedMessage: { id: first.queuedMessage.id },
      });
      expect(third).toMatchObject({
        delivery: "queued",
        queuedMessage: { id: first.queuedMessage.id },
      });
      expect(queuedTexts(harness, threadId)).toEqual(["Finish the release"]);
    });
  });

  it("still queues a different message behind a pending one", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "idle");
      setServerUpdateDraining(harness.db, true);

      await send(harness, threadId, "Finish the release");
      await send(harness, threadId, "Also check the feed");

      expect(queuedTexts(harness, threadId)).toEqual([
        "Finish the release",
        "Also check the feed",
      ]);
    });
  });

  it("returns the pending queued message when the same queued message is created twice", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedConnectedThread(harness, "active");

      const first = await createQueuedMessage(harness, threadId, "Next step");
      const second = await createQueuedMessage(harness, threadId, "Next step");

      expect(second).toBe(first);
      expect(queuedTexts(harness, threadId)).toEqual(["Next step"]);
    });
  });
});
