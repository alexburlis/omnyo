import {
  getThread,
  listEvents,
  threadReceipts,
  clearPluginHomeThreads,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  threadSchema,
  threadAttentionResultSchema,
  threadQuestionInputSchema,
} from "@omnyo/domain";
import { threadSearchResponseSchema } from "@omnyo/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reportNextEnvironmentAttachSuccess } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { seedThread, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PLUGIN = "chief";

async function create(
  harness: TestAppHarness,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function listIds(harness: TestAppHarness, query = "") {
  const response = await harness.app.request(`/api/v1/threads${query}`);
  expect(response.status).toBe(200);
  const body = await readJson(response);

  return (body as { id: string }[]).map((thread) => thread.id);
}

describe("idle plugin home chats", () => {
  it("creates an idle chat with no turn and no Inbox receipt", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness);

      const response = await create(
        harness,
        {
          origin: "plugin",
          originPluginId: PLUGIN,
          projectId: project.id,
          providerId: "codex",
          input: [],
          idle: true,
          pluginHome: true,
          pinned: true,
          title: "Chief",
          environment: { type: "reuse", environmentId: environment.id },
        },
        { [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN },
      );

      expect(response.status, await response.clone().text()).toBe(201);
      const { id } = threadSchema.parse(await response.json());

      await reportNextEnvironmentAttachSuccess(harness, id).catch(() => {});
      await expect.poll(() => getThread(harness.db, id)?.status).toBe("idle");

      const events = listEvents(harness.db, { threadId: id });
      expect(
        events.some((event) => event.type === "client/turn/requested"),
      ).toBe(false);
      expect(events.some((event) => event.type === "client/thread/start")).toBe(
        false,
      );
      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, id))
          .all(),
      ).toEqual([]);

      expect(getThread(harness.db, id)).toMatchObject({
        pluginHome: true,
        originPluginId: PLUGIN,
        visibility: "visible",
      });
      expect(getThread(harness.db, id)?.pinnedAt).not.toBeNull();
    });
  });

  it("accepts the owner's answer to a question opened in an idle chat", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness);

      const response = await create(
        harness,
        {
          origin: "plugin",
          originPluginId: PLUGIN,
          projectId: project.id,
          providerId: "codex",
          input: [],
          idle: true,
          pluginHome: true,
          environment: { type: "reuse", environmentId: environment.id },
        },
        { [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN },
      );

      const { id } = threadSchema.parse(await response.json());

      await reportNextEnvironmentAttachSuccess(harness, id).catch(() => {});
      await expect.poll(() => getThread(harness.db, id)?.status).toBe("idle");

      const attention = (value: object) =>
        harness.app.request(`/api/v1/threads/${id}/attention`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        });

      const opened = threadAttentionResultSchema.parse(
        await (
          await attention({
            action: "open",
            questions: [
              threadQuestionInputSchema.parse({
                prompt: "Make this a rule?",
                mode: "optional",
                options: [
                  { value: "ask", label: "Yes" },
                  { value: "reject", label: "No" },
                ],
              }),
            ],
          })
        ).json(),
      ).questions[0];

      if (opened === undefined) throw new Error("Question missing");

      const answered = await attention({
        action: "answer",
        id: opened.id,
        revision: opened.revision,
        answer: { selected: ["ask"] },
      });

      expect(answered.status, await answered.clone().text()).toBe(200);
    });
  });

  it("refuses idle chats with input and home chats from a caller that is not the plugin", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness);

      const base = {
        origin: "plugin",
        originPluginId: PLUGIN,
        projectId: project.id,
        providerId: "codex",
        environment: { type: "reuse", environmentId: environment.id },
      };

      const withInput = await create(
        harness,
        { ...base, idle: true, input: [{ type: "text", text: "hi" }] },
        { [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN },
      );

      expect(withInput.status).toBe(400);

      const empty = await create(harness, { ...base, input: [] });
      expect(empty.status).toBe(400);

      const ownerClaim = await create(harness, {
        ...base,
        idle: true,
        input: [],
        pluginHome: true,
      });

      expect(ownerClaim.status).toBe(403);

      const otherPlugin = await create(
        harness,
        { ...base, idle: true, input: [], pluginHome: true },
        { [INBOX_CALLER_PLUGIN_HEADER]: "someone-else" },
      );

      expect(otherPlugin.status).toBe(403);
    });
  });

  it("keeps home chats out of lists, search and counts, and lists them on request", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: ordinary,
      } = seedThreadFixture(harness);

      const home = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        originPluginId: PLUGIN,
        title: "Test home",
      });

      const flag = await harness.app.request(`/api/v1/threads/${home.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN,
        },
        body: JSON.stringify({ experimental_pluginHome: true }),
      });

      expect(flag.status, await flag.clone().text()).toBe(200);

      expect(await listIds(harness)).toEqual([ordinary.id]);
      expect(await listIds(harness, `?projectId=${project.id}`)).toEqual([
        ordinary.id,
      ]);
      expect(
        new Set(await listIds(harness, "?includePluginHome=true")),
      ).toEqual(new Set([ordinary.id, home.id]));

      const count = await harness.app.request("/api/v1/threads/count");
      expect(await readJson(count)).toEqual({ total: 1 });

      const search = await harness.app.request(
        "/api/v1/threads/search?query=Test&limitPerGroup=10",
      );

      expect(search.status).toBe(200);

      const found = threadSearchResponseSchema
        .parse(await readJson(search))
        .active.results.map((result) => result.thread.id);

      expect(found).toContain(ordinary.id);
      expect(found).not.toContain(home.id);
    });
  });

  it("lets only the creating plugin set the flag, lets the owner clear it, and clears it for a plugin", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness);

      const home = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        originPluginId: PLUGIN,
      });

      const patch = (value: boolean, headers: Record<string, string>) =>
        harness.app.request(`/api/v1/threads/${home.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ experimental_pluginHome: value }),
        });

      expect((await patch(true, {})).status).toBe(403);
      expect(
        (await patch(true, { [INBOX_CALLER_PLUGIN_HEADER]: "other" })).status,
      ).toBe(403);
      expect(
        (await patch(true, { [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN })).status,
      ).toBe(200);
      expect(getThread(harness.db, home.id)?.pluginHome).toBe(true);

      expect((await patch(false, {})).status).toBe(200);
      expect(getThread(harness.db, home.id)?.pluginHome).toBe(false);

      expect(
        (await patch(true, { [INBOX_CALLER_PLUGIN_HEADER]: PLUGIN })).status,
      ).toBe(200);
      expect(
        clearPluginHomeThreads(harness.db, harness.deps.hub, PLUGIN),
      ).toEqual([home.id]);
      expect(getThread(harness.db, home.id)?.pluginHome).toBe(false);
    });
  });
});
