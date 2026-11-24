import { describe, expect, it } from "vitest";
import { getProject } from "@omnyo/db";
import { seedHost, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

describe("public project custom icons", () => {
  it("saves and returns a custom icon, rejects malformed images, and resets", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const update = (customIcon: string | null) =>
        harness.app.request(`/api/v1/projects/${project.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ customIcon }),
        });

      const saved = await update(PNG);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ customIcon: PNG });
      expect(getProject(harness.db, project.id)?.customIcon).toBe(PNG);
      const invalid = await update("data:image/png;base64,aGVsbG8=");
      expect(invalid.status).toBeGreaterThanOrEqual(400);
      expect(invalid.status).toBeLessThan(500);
      expect(getProject(harness.db, project.id)?.customIcon).toBe(PNG);
      const reset = await update(null);
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ customIcon: null });
      expect(getProject(harness.db, project.id)?.customIcon).toBeNull();
    });
  });
});
