import { getThread } from "@omnyo/db";
import {
  createThreadGroupResponseSchema,
  sidebarBootstrapResponseSchema,
  threadGroupMutationResponseSchema,
  threadGroupSchema,
} from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("public thread group routes", () => {
  it("groups chats from one project, renames and ungroups them", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const commander = seedThread(harness.deps, {
        projectId: project.id,
        title: "COMMANDER CUSTOM MODEL",
      });

      const e4b = seedThread(harness.deps, {
        projectId: project.id,
        title: "E4B CUSTOM MODEL",
      });

      const outsider = seedThread(harness.deps, {
        projectId: project.id,
        title: "Landing SEO",
      });

      const createResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("POST", {
          name: " Custom models ",
          threadIds: [commander.id, e4b.id, commander.id],
        }),
      );

      expect(createResponse.status).toBe(201);

      const created = createThreadGroupResponseSchema.parse(
        await readJson(createResponse),
      );

      expect(created.group).toMatchObject({
        projectId: project.id,
        name: "Custom models",
      });
      expect(created.threadIds).toEqual([commander.id, e4b.id]);
      expect(getThread(harness.deps.db, commander.id)?.groupId).toBe(
        created.group.id,
      );
      expect(getThread(harness.deps.db, outsider.id)?.groupId).toBeNull();

      const members = await harness.app.request(
        `/api/v1/threads?groupId=${created.group.id}`,
      );

      expect(members.status).toBe(200);
      expect(
        ((await readJson(members)) as { id: string }[])
          .map((thread) => thread.id)
          .sort(),
      ).toEqual([commander.id, e4b.id].sort());

      const listResponse = await harness.app.request(
        `/api/v1/thread-groups?projectId=${project.id}`,
      );

      expect(
        threadGroupSchema.array().parse(await readJson(listResponse)),
      ).toEqual([created.group]);

      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/sidebar-bootstrap")),
      );

      expect(bootstrap.groups).toEqual([created.group]);

      const addResponse = await harness.app.request(
        `/api/v1/threads/${outsider.id}`,
        jsonRequest("PATCH", { groupId: created.group.id }),
      );

      expect(addResponse.status).toBe(200);
      expect(getThread(harness.deps.db, outsider.id)?.groupId).toBe(
        created.group.id,
      );

      const removeResponse = await harness.app.request(
        `/api/v1/threads/${outsider.id}`,
        jsonRequest("PATCH", { groupId: null }),
      );

      expect(removeResponse.status).toBe(200);
      expect(getThread(harness.deps.db, outsider.id)?.groupId).toBeNull();

      const renameResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("PATCH", { id: created.group.id, name: "Model work" }),
      );

      expect(
        threadGroupMutationResponseSchema.parse(await readJson(renameResponse)),
      ).toEqual({
        id: created.group.id,
        projectId: project.id,
        name: "Model work",
        updatedThreadCount: 0,
      });

      const deleteResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("DELETE", { id: created.group.id }),
      );

      expect(
        threadGroupMutationResponseSchema.parse(await readJson(deleteResponse)),
      ).toEqual({
        id: created.group.id,
        projectId: project.id,
        name: "Model work",
        updatedThreadCount: 2,
      });
      expect(getThread(harness.deps.db, commander.id)?.groupId).toBeNull();
      expect(getThread(harness.deps.db, e4b.id)?.groupId).toBeNull();

      const missingResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("DELETE", { id: created.group.id }),
      );

      expect(missingResponse.status).toBe(404);
      await expect(readJson(missingResponse)).resolves.toMatchObject({
        code: "group_not_found",
      });
    });
  });

  it("refuses chats from another project and unknown chats", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const { project: otherProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Other",
        path: "/tmp/other-project",
      });

      const here = seedThread(harness.deps, { projectId: project.id });
      const there = seedThread(harness.deps, { projectId: otherProject.id });

      const mixedResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("POST", { name: "Mixed", threadIds: [here.id, there.id] }),
      );

      expect(mixedResponse.status).toBe(400);
      await expect(readJson(mixedResponse)).resolves.toMatchObject({
        code: "group_project_mismatch",
      });

      const unknownResponse = await harness.app.request(
        "/api/v1/thread-groups",
        jsonRequest("POST", { name: "Ghost", threadIds: ["thr_missing"] }),
      );

      expect(unknownResponse.status).toBe(404);

      const created = createThreadGroupResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/thread-groups",
            jsonRequest("POST", { name: "Here", threadIds: [here.id] }),
          ),
        ),
      );

      const crossProjectMove = await harness.app.request(
        `/api/v1/threads/${there.id}`,
        jsonRequest("PATCH", { groupId: created.group.id }),
      );

      expect(crossProjectMove.status).toBe(400);
      await expect(readJson(crossProjectMove)).resolves.toMatchObject({
        code: "group_project_mismatch",
      });
      expect(getThread(harness.deps.db, there.id)?.groupId).toBeNull();
    });
  });
});
