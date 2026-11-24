import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";
import { resolveSkillCatalog } from "../../src/services/skills/skill-catalog.js";

it("lists the same eligible server skills without reading runtime trees and observes edited metadata", async () => {
  await withTestHarness(async ({ deps, config }) => {
    const root = path.join(config.dataDir, "skills", "review");
    await mkdir(path.join(root, "references"), { recursive: true });
    const file = path.join(root, "SKILL.md");
    const reference = path.join(root, "references", "large.txt");
    await writeFile(
      file,
      "---\nname: review\ndescription: Review code\n---\nSkill body\n",
    );
    await writeFile(reference, "reference ".repeat(10000));

    const expected = resolveSkillCatalog(deps).map(
      ({ provenance, runtimeSource }) => ({
        provenance,
        name: runtimeSource.name,
        description: runtimeSource.description,
      }),
    );

    const spy = vi.spyOn(fs, "readFileSync");

    try {
      const actual = await deps.commandMetadata.resolve({
        projectSources: [],
        sharedSources: [],
      });

      expect(
        actual.map(({ provenance, runtimeSource }) => ({
          provenance,
          name: runtimeSource.name,
          description: runtimeSource.description,
        })),
      ).toEqual(expected);
      expect(spy.mock.calls.filter(([target]) => target === reference)).toEqual(
        [],
      );
      await writeFile(
        file,
        "---\nname: review\ndescription: Updated metadata\n---\nSkill body\n",
      );
      expect(
        (
          await deps.commandMetadata.resolve({
            projectSources: [],
            sharedSources: [],
          })
        ).find(({ runtimeSource }) => runtimeSource.name === "review")
          ?.runtimeSource.description,
      ).toBe("Updated metadata");
      expect(
        resolveSkillCatalog(deps).find(
          ({ runtimeSource }) => runtimeSource.name === "review",
        )?.runtimeSource.description,
      ).toBe("Updated metadata");
    } finally {
      spy.mockRestore();
    }
  });
});
