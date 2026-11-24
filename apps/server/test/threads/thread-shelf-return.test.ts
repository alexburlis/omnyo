import { archiveThread, getThread, listQueuedThreadMessages } from "@omnyo/db";
import {
  threadQuestionInputSchema,
  threadSchema,
  type ThreadStatus,
  type ThreadVisibility,
} from "@omnyo/domain";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { sendQueuedMessageNow } from "../../src/services/threads/queued-messages.js";
import { interruptActiveThreadsForHost } from "../../src/services/threads/thread-lifecycle.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  createCommandApprovalPayload,
  createUserQuestionPayload,
} from "../helpers/pending-interactions.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface SeedMemberArgs {
  member: string;
  parentThreadId: string | null;
  status?: ThreadStatus;
  visibility?: ThreadVisibility;
}

interface FamilyStatuses {
  root?: ThreadStatus;
  child?: ThreadStatus;
  hidden?: ThreadStatus;
}

const continueResultSchema = z.object({
  results: z.array(z.object({ threadId: z.string() })),
});

const continuationsSchema = z.object({
  threads: z.array(z.object({ threadId: z.string() })),
});

const question = threadQuestionInputSchema.parse({
  prompt: "Which direction?",
  mode: "optional",
  options: [
    { value: "a", label: "Compact" },
    { value: "b", label: "Detailed" },
  ],
});

function seedShelfWorld(harness: TestAppHarness, name: string) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-shelf-return-${name}`,
  });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/shelf-return-${name}`,
  });

  const seedMember = (args: SeedMemberArgs) => {
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: `/tmp/shelf-return-${name}-${args.member}`,
    });

    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      parentThreadId: args.parentThreadId,
      status: args.status ?? "idle",
      title: args.member,
      visibility: args.visibility ?? "visible",
    });

    seedThreadRuntimeState(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId: `provider-shelf-return-${name}-${args.member}`,
    });

    if (thread.status === "active") {
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: `provider-shelf-return-${name}-${args.member}`,
        turnId: `turn-${args.member}`,
      });
    }

    return { environment, thread };
  };

  return { host, project, seedMember, session };
}

function seedShelfFamily(
  harness: TestAppHarness,
  name: string,
  statuses: FamilyStatuses = {},
) {
  const world = seedShelfWorld(harness, name);

  const root = world.seedMember({
    member: "root",
    parentThreadId: null,
    status: statuses.root,
  });

  const child = world.seedMember({
    member: "child",
    parentThreadId: root.thread.id,
    status: statuses.child,
  });

  const hidden = world.seedMember({
    member: "hidden",
    parentThreadId: root.thread.id,
    status: statuses.hidden,
    visibility: "hidden",
  });

  return {
    ...world,
    root,
    child,
    hidden,
    familyIds: [root.thread.id, child.thread.id, hidden.thread.id],
  };
}

async function shelve(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/shelve`,
    { method: "POST" },
  );

  expect(response.status).toBe(200);
}

function shelvedIds(harness: TestAppHarness, threadIds: readonly string[]) {
  return threadIds.filter(
    (threadId) => getThread(harness.db, threadId)?.shelvedAt !== null,
  );
}

function recordShelfChanges(harness: TestAppHarness) {
  const threadIds: string[] = [];

  harness.hub.onChangedMessage((message) => {
    if (
      message.entity === "thread" &&
      message.changes.includes("shelf-state-changed")
    ) {
      threadIds.push(message.id);
    }
  });

  return threadIds;
}

function postJson(harness: TestAppHarness, path: string, body: object) {
  return harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sendText(
  harness: TestAppHarness,
  threadId: string,
  text: string,
  extra: object = {},
) {
  return postJson(harness, `/threads/${threadId}/send`, {
    input: textInput(text),
    mode: "auto",
    ...extra,
  });
}

function patchThread(harness: TestAppHarness, threadId: string, body: object) {
  return harness.app.request(`/api/v1/threads/${threadId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ShelfFamily = ReturnType<typeof seedShelfFamily>;

interface AdmissionCase {
  name: string;
  statuses?: FamilyStatuses;
  admit(harness: TestAppHarness, family: ShelfFamily): Promise<void>;
}

const admissionCases: AdmissionCase[] = [
  {
    name: "a send to the idle top-level chat",
    async admit(harness, family) {
      const response = await sendText(harness, family.root.thread.id, "next");

      expect(response.status).toBe(200);
    },
  },
  {
    name: "a send to an idle sub-chat",
    async admit(harness, family) {
      const response = await sendText(harness, family.child.thread.id, "next");

      expect(response.status).toBe(200);
    },
  },
  {
    name: "a steer into the running top-level chat",
    statuses: { root: "active" },
    async admit(harness, family) {
      const response = await sendText(harness, family.root.thread.id, "also", {
        mode: "steer",
      });

      expect(response.status).toBe(200);
    },
  },
  {
    name: "a message from another chat",
    async admit(harness, family) {
      const sender = seedThread(harness.deps, {
        projectId: family.project.id,
        title: "sender",
      });

      const response = await sendText(harness, family.root.thread.id, "hi", {
        senderThreadId: sender.id,
      });

      expect(response.status).toBe(200);
    },
  },
  {
    name: "a parent notice from a sub-chat",
    async admit(harness, family) {
      await expect(
        queueParentSystemMessage(harness.deps, {
          input: textInput("child finished"),
          parentThreadId: family.root.thread.id,
          systemMessageKind: "child-completed",
          systemMessageSubject: {
            kind: "thread",
            threadId: family.child.thread.id,
            threadName: "child",
          },
        }),
      ).resolves.toBe(true);
    },
  },
  {
    name: "a parent notice steered into the running top-level chat",
    statuses: { root: "active" },
    async admit(harness, family) {
      await expect(
        queueParentSystemMessage(harness.deps, {
          input: textInput("child finished"),
          parentThreadId: family.root.thread.id,
          systemMessageKind: "child-completed",
          systemMessageSubject: null,
        }),
      ).resolves.toBe(true);
    },
  },
  {
    name: "a queued message dispatch",
    async admit(harness, family) {
      const queued = seedQueuedMessage(harness.deps, {
        threadId: family.root.thread.id,
        content: textInput("queued earlier"),
      });

      await expect(
        sendQueuedMessageNow(harness.deps, {
          overrideFailures: true,
          mode: "auto",
          queuedMessageId: queued.id,
          threadId: family.root.thread.id,
        }),
      ).resolves.toEqual({ delivery: "sent" });
    },
  },
  {
    name: "a retry of the failed top-level turn",
    statuses: { root: "error" },
    async admit(harness, family) {
      const response = await postJson(
        harness,
        `/threads/${family.root.thread.id}/retry`,
        {},
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ delivery: "sent" });
    },
  },
  {
    name: "a new visible sub-chat",
    async admit(harness, family) {
      const response = await postJson(harness, "/threads", {
        origin: "app",
        projectId: family.project.id,
        providerId: "codex",
        model: "gpt-5",
        input: textInput("Take this part"),
        environment: {
          type: "reuse",
          environmentId: family.child.environment.id,
        },
        parentThreadId: family.root.thread.id,
      });

      expect(response.status).toBe(201);
    },
  },
];

describe("the Shelf is owner-only", () => {
  it("returns a distinct coordinator timing for each successful Shelf response", async () => {
    await withTestHarness(async (harness) => {
      const { root } = seedShelfFamily(harness, "timing");
      const path = `/api/v1/threads/${root.thread.id}/shelve`;
      const first = await harness.app.request(path, { method: "POST" });
      const second = await harness.app.request(path, { method: "POST" });

      const missing = await harness.app.request(
        "/api/v1/threads/missing/shelve",
        {
          method: "POST",
        },
      );

      const timing = /^omnyo_shelve;dur=\d+(?:\.\d+)?;desc="([a-f0-9-]{36})"$/u;

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(missing.status).toBe(404);
      const firstTiming = first.headers.get("server-timing");
      const secondTiming = second.headers.get("server-timing");
      expect(firstTiming).toMatch(timing);
      expect(secondTiming).toMatch(timing);
      expect(firstTiming?.match(timing)?.[1]).not.toBe(
        secondTiming?.match(timing)?.[1],
      );
      expect(missing.headers.has("server-timing")).toBe(false);
    });
  });

  it.each(admissionCases)(
    "keeps the whole family on the Shelf after $name",
    async ({ name, statuses, admit }) => {
      await withTestHarness(async (harness) => {
        const family = seedShelfFamily(
          harness,
          name.replaceAll(" ", "-"),
          statuses,
        );

        await shelve(harness, family.root.thread.id);
        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        const shelfChanges = recordShelfChanges(harness);

        await admit(harness, family);

        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        expect(shelfChanges).toEqual([]);
      });
    },
  );

  it.each([
    { name: "a top-level run finishing", member: "root", event: "succeeded" },
    { name: "a top-level run failing", member: "root", event: "failed" },
    { name: "a sub-chat run failing", member: "child", event: "failed" },
  ] as const)(
    "keeps the whole family on the Shelf after $name",
    async ({ member, event }) => {
      await withTestHarness(async (harness) => {
        const family = seedShelfFamily(harness, `run-${member}-${event}`, {
          [member]: "active",
        });

        await shelve(harness, family.root.thread.id);
        const shelfChanges = recordShelfChanges(harness);

        const outcome = applyLoggedThreadLifecycleEvent(harness.deps, {
          threadId: family[member].thread.id,
          event: { type: event === "failed" ? "run.failed" : "run.succeeded" },
        });

        expect(outcome).toMatchObject({
          applied: true,
          thread: { shelvedAt: expect.any(Number) },
        });
        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        expect(shelfChanges).toEqual([]);
      });
    },
  );

  it("keeps the whole family on the Shelf when a lost connection fails its running chat", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "connection-lost", {
        root: "active",
      });

      await shelve(harness, family.root.thread.id);
      const shelfChanges = recordShelfChanges(harness);

      interruptActiveThreadsForHost(harness.deps, {
        hostId: family.host.id,
        includeStopping: false,
        reason: "host-daemon-restarted",
        cause: "host-connection-lost",
      });

      expect(getThread(harness.db, family.root.thread.id)?.status).toBe(
        "error",
      );
      expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
      expect(shelfChanges).toEqual([]);
    });
  });

  it("keeps the family shelved when only a sub-chat run finishes", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "child-finishes", {
        child: "active",
      });

      await shelve(harness, family.root.thread.id);
      const shelfChanges = recordShelfChanges(harness);

      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: family.child.thread.id,
        event: { type: "run.succeeded" },
      });

      expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
      expect(shelfChanges).toEqual([]);
    });
  });

  it.each(["root", "child"] as const)(
    "keeps the whole family on the Shelf when a question opens in the %s chat",
    async (member) => {
      await withTestHarness(async (harness) => {
        const family = seedShelfFamily(harness, `question-${member}`);

        await shelve(harness, family.root.thread.id);
        const shelfChanges = recordShelfChanges(harness);

        const response = await postJson(
          harness,
          `/threads/${family[member].thread.id}/attention`,
          { action: "open", questions: [question] },
        );

        expect(response.status).toBe(200);
        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        expect(shelfChanges).toEqual([]);
      });
    },
  );

  it("keeps the whole family on the Shelf when a callback wait opens", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "callback");

      const source = family.seedMember({
        member: "source",
        parentThreadId: null,
        status: "active",
      });

      await shelve(harness, family.root.thread.id);

      const response = await postJson(
        harness,
        `/threads/${family.root.thread.id}/attention`,
        {
          action: "wait",
          sourceThreadId: source.thread.id,
          reason: "Waiting for the source",
        },
      );

      expect(response.status).toBe(200);
      expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
    });
  });

  it.each([
    { name: "an approval", payload: createCommandApprovalPayload() },
    { name: "an answer", payload: createUserQuestionPayload() },
  ])(
    "keeps the whole family on the Shelf when its running top-level chat asks for $name",
    async ({ name, payload }) => {
      await withTestHarness(async (harness) => {
        const family = seedShelfFamily(
          harness,
          `provider-${name.replaceAll(" ", "-")}`,
          { root: "active" },
        );

        await shelve(harness, family.root.thread.id);
        const shelfChanges = recordShelfChanges(harness);

        const response = await harness.app.request(
          "/internal/session/interactive-request",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: family.session.id,
              interaction: {
                threadId: family.root.thread.id,
                turnId: "turn-root",
                providerId: family.root.thread.providerId,
                providerThreadId: "provider-request-root",
                providerRequestId: "request-root",
                payload,
              },
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(await readJson(response)).toMatchObject({ outcome: "created" });
        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        expect(shelfChanges).toEqual([]);
      });
    },
  );

  it("keeps the whole family on the Shelf when a plugin asks a sub-chat for input", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "plugin-request");

      await shelve(harness, family.root.thread.id);
      const shelfChanges = recordShelfChanges(harness);
      const controller = new AbortController();

      const request = harness.deps.pendingInteractions.requestPluginInteraction(
        {
          pluginId: "secrets",
          owner: { pluginId: "secrets" },
          threadId: family.child.thread.id,
          rendererId: "secret-request",
          title: "Add secrets",
          payload: { fields: [{ name: "API_KEY" }] },
          presentation: {
            label: {
              pending: "Waiting for Add secrets",
              completed: "Submitted Add secrets",
            },
            icon: { glyph: "Toolbox" },
          },
          describeSubmission: null,
          timeoutMs: 10_000,
          signal: controller.signal,
        },
      );

      try {
        expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
        expect(shelfChanges).toEqual([]);
      } finally {
        controller.abort();
        await request;
      }
    });
  });

  it("keeps the whole family on the Shelf when a visible sub-chat is created to start later", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "scheduled-child");

      await shelve(harness, family.root.thread.id);
      const shelfChanges = recordShelfChanges(harness);

      const response = await postJson(harness, "/threads", {
        origin: "app",
        projectId: family.project.id,
        providerId: "codex",
        model: "gpt-5",
        input: textInput("Pick this up tomorrow"),
        environment: {
          type: "reuse",
          environmentId: family.child.environment.id,
        },
        parentThreadId: family.root.thread.id,
        sendAt: Date.now() + 3_600_000,
      });

      expect(response.status).toBe(201);
      const created = threadSchema.parse(await readJson(response));
      expect(listQueuedThreadMessages(harness.db, created.id)).toHaveLength(1);
      expect(shelvedIds(harness, [...family.familyIds, created.id])).toEqual(
        family.familyIds,
      );
      expect(shelfChanges).toEqual([]);
    });
  });

  it("keeps the family shelved for activity in a hidden member", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "hidden-activity", {
        hidden: "active",
      });

      const hiddenMover = family.seedMember({
        member: "hidden-mover",
        parentThreadId: null,
        visibility: "hidden",
      });

      await shelve(harness, family.root.thread.id);
      const shelfChanges = recordShelfChanges(harness);

      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: family.hidden.thread.id,
        event: { type: "run.failed" },
      });

      expect(
        (await sendText(harness, family.hidden.thread.id, "retry")).status,
      ).toBe(200);

      expect(
        (
          await postJson(harness, "/threads", {
            origin: "app",
            projectId: family.project.id,
            providerId: "codex",
            model: "gpt-5",
            input: textInput("Quiet helper"),
            environment: {
              type: "reuse",
              environmentId: family.child.environment.id,
            },
            parentThreadId: family.root.thread.id,
            visibility: "hidden",
          })
        ).status,
      ).toBe(201);

      expect(
        (
          await patchThread(harness, hiddenMover.thread.id, {
            parentThreadId: family.root.thread.id,
          })
        ).status,
      ).toBe(200);

      expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);
      expect(shelfChanges).toEqual([]);
    });
  });

  it("emits no shelf change for a family that is not shelved", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "not-shelved", {
        child: "active",
      });

      const shelfChanges = recordShelfChanges(harness);

      expect(
        (await sendText(harness, family.root.thread.id, "go")).status,
      ).toBe(200);
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: family.child.thread.id,
        event: { type: "run.failed" },
      });
      expect(
        (
          await postJson(
            harness,
            `/threads/${family.root.thread.id}/attention`,
            {
              action: "open",
              questions: [question],
            },
          )
        ).status,
      ).toBe(200);

      expect(shelfChanges).toEqual([]);

      await shelve(harness, family.root.thread.id);

      expect([...shelfChanges].sort()).toEqual([...family.familyIds].sort());
    });
  });

  it("keeps the family on the Shelf when one of its archived sub-chats is unarchived", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "unarchive");

      archiveThread(harness.db, harness.hub, family.child.thread.id);
      await shelve(harness, family.root.thread.id);
      expect(shelvedIds(harness, family.familyIds)).toEqual([
        family.root.thread.id,
        family.hidden.thread.id,
      ]);

      const response = await postJson(
        harness,
        `/threads/${family.child.thread.id}/unarchive`,
        {},
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, family.child.thread.id)?.archivedAt).toBe(
        null,
      );
      expect(shelvedIds(harness, family.familyIds)).toEqual([
        family.root.thread.id,
        family.hidden.thread.id,
      ]);
    });
  });

  it("keeps a shelved family on the Shelf when a visible chat moves into it", async () => {
    await withTestHarness(async (harness) => {
      const family = seedShelfFamily(harness, "reparent");

      const mover = family.seedMember({
        member: "mover",
        parentThreadId: null,
      });

      await shelve(harness, family.root.thread.id);
      await shelve(harness, mover.thread.id);

      const detached = await patchThread(harness, family.child.thread.id, {
        parentThreadId: null,
      });

      expect(detached.status).toBe(200);
      expect(shelvedIds(harness, family.familyIds)).toEqual(family.familyIds);

      const moved = await patchThread(harness, mover.thread.id, {
        parentThreadId: family.root.thread.id,
      });

      expect(moved.status).toBe(200);
      expect(threadSchema.parse(await readJson(moved)).shelvedAt).toEqual(
        expect.any(Number),
      );
      expect(
        shelvedIds(harness, [
          family.root.thread.id,
          family.hidden.thread.id,
          mover.thread.id,
        ]),
      ).toEqual([
        family.root.thread.id,
        family.hidden.thread.id,
        mover.thread.id,
      ]);
      expect(shelvedIds(harness, [family.child.thread.id])).toEqual([
        family.child.thread.id,
      ]);
    });
  });

  it("leaves shelved chats out of Continue all", async () => {
    await withTestHarness(async (harness) => {
      const world = seedShelfWorld(harness, "continue-all");

      const shelved = world.seedMember({
        member: "shelved",
        parentThreadId: null,
        status: "error",
      });

      const active = world.seedMember({
        member: "active",
        parentThreadId: null,
        status: "error",
      });

      await shelve(harness, shelved.thread.id);

      const eligible = await harness.app.request(
        "/api/v1/threads/continuations/eligible",
      );

      expect(eligible.status).toBe(200);
      expect(
        continuationsSchema
          .parse(await readJson(eligible))
          .threads.map((thread) => thread.threadId),
      ).toEqual([active.thread.id]);

      const continued = await postJson(harness, "/threads/continue-all", {});

      expect(continued.status).toBe(200);
      expect(
        continueResultSchema
          .parse(await readJson(continued))
          .results.map((result) => result.threadId),
      ).toEqual([active.thread.id]);
      expect(listQueuedThreadMessages(harness.db, shelved.thread.id)).toEqual(
        [],
      );
      expect(getThread(harness.db, shelved.thread.id)).toMatchObject({
        status: "error",
        shelvedAt: expect.any(Number),
      });
    });
  });
});
