import { upsertProjectExecutionDefaults } from "@omnyo/db";
import { describe, expect, it } from "vitest";
import { registerFirstPartyProviders } from "../helpers/provider-registry.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

describe("project reads during provider startup", () => {
  it("persists Personal among projects when reordered from either side", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const first = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "First",
        path: "/tmp/personal-order-first",
      }).project;

      const second = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Second",
        path: "/tmp/personal-order-second",
      }).project;

      const reorder = (
        id: string,
        previousProjectId: string | null,
        nextProjectId: string | null,
      ) =>
        harness.app.request(`/api/v1/projects/${id}/order`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previousProjectId, nextProjectId }),
        });

      expect((await reorder("proj_personal", first.id, second.id)).status).toBe(
        200,
      );
      const sidebar = await harness.app.request("/api/v1/sidebar-bootstrap");
      expect(await sidebar.json()).toMatchObject({
        orderedProjectIds: [first.id, "proj_personal", second.id],
        projects: [{ id: first.id }, { id: second.id }],
        personalProject: { id: "proj_personal" },
      });

      expect((await reorder(second.id, null, first.id)).status).toBe(200);
      expect((await reorder(first.id, "proj_personal", null)).status).toBe(200);

      const listing = await harness.app.request(
        "/api/v1/projects?includePersonal=true",
      );

      expect(
        (await listing.json()).map((project: { id: string }) => project.id),
      ).toEqual([second.id, "proj_personal", first.id]);
      const standardListing = await harness.app.request("/api/v1/projects");
      expect(
        (await standardListing.json()).map(
          (project: { id: string }) => project.id,
        ),
      ).toEqual([second.id, first.id]);
    });
  });

  it("preserves shared-host threads and defaults across Personal and standard projects", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const first = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "First",
        path: "/tmp/sidebar-first",
      }).project;

      const second = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Second",
        path: "/tmp/sidebar-second",
      }).project;

      const expected = ["proj_personal", first.id, second.id].map(
        (projectId) => {
          const environment = seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId,
          });

          const thread = seedThread(harness.deps, {
            projectId,
            environmentId: environment.id,
            status: "active",
          });

          const defaults = {
            providerId: "codex",
            model: `model-${projectId}`,
            reasoningLevel: "medium" as const,
            permissionMode: "auto" as const,
            serviceTier: "default" as const,
          };

          upsertProjectExecutionDefaults(harness.db, {
            projectId,
            ...defaults,
          });

          return {
            id: projectId,
            defaultExecutionOptions: defaults,
            threads: [
              {
                id: thread.id,
                environmentHostId: host.id,
                runtime: { displayStatus: "active" },
              },
            ],
          };
        },
      );

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");
      expect(response.status).toBe(200);
      const sidebar = await response.json();
      expect(sidebar.personalProject).toMatchObject(expected[0]);
      expect(sidebar.projects).toMatchObject(expected.slice(1));
      expect(sidebar.projects).toHaveLength(2);
      expect(sidebar.orderedProjectIds).toEqual([
        "proj_personal",
        first.id,
        second.id,
      ]);
    });
  });

  it("reads Personal by id while preserving project mutation restrictions", async () => {
    await withTestHarness(async (harness) => {
      const projectPath = "/api/v1/projects/proj_personal";
      const response = await harness.app.request(projectPath);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        sources: [],
      });

      const rename = await harness.app.request(projectPath, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });

      expect(rename.status).toBe(404);

      const deletion = await harness.app.request(projectPath, {
        method: "DELETE",
      });

      expect(deletion.status).toBe(409);

      const missing = await harness.app.request(
        "/api/v1/projects/proj_missing",
      );

      expect(missing.status).toBe(404);
    });
  });

  it("returns saved defaults before registration and with an unavailable provider", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const defaults = {
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium" as const,
          permissionMode: "auto" as const,
          serviceTier: "default" as const,
        };

        for (const phase of ["starting", "unavailable"] as const) {
          if (phase === "unavailable") {
            upsertProjectExecutionDefaults(harness.db, {
              projectId: "proj_personal",
              ...defaults,
            });
            await registerFirstPartyProviders(harness.deps.providerRegistry, {
              unavailablePluginIds: ["provider-codex"],
            });
          }

          const expectedDefaults = phase === "starting" ? null : defaults;

          const sidebar = await harness.app.request(
            "/api/v1/sidebar-bootstrap",
          );

          expect(sidebar.status).toBe(200);
          expect(
            (await sidebar.json()).personalProject.defaultExecutionOptions,
          ).toEqual(expectedDefaults);

          const projects = await harness.app.request(
            "/api/v1/projects?include=threads&includePersonal=true",
          );

          expect(projects.status).toBe(200);
          expect((await projects.json())[0].defaultExecutionOptions).toEqual(
            expectedDefaults,
          );

          const options = await harness.app.request(
            "/api/v1/projects/proj_personal/default-execution-options",
          );

          expect(options.status).toBe(200);
          expect(await options.json()).toEqual(expectedDefaults);
        }
      },
    );
  });
});
