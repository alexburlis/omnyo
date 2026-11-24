import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readRegistrySkillProvenance,
  writeRegistrySkillProvenance,
} from "../../src/services/skills/registry-skill-provenance.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("malformed provenance remains visible and cannot be replaced by a new writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-provenance-invalid-"));
  roots.push(root);
  await writeFile(
    join(root, ".omnyo-registry-skill.json"),
    "invalid user bytes",
  );
  expect(() => readRegistrySkillProvenance(root)).toThrow(/invalid/u);
  await expect(
    writeRegistrySkillProvenance({
      skillDirectoryPath: root,
      registrySkillId: "owned/skill",
    }),
  ).rejects.toThrow(/invalid/u);
  expect(await readFile(join(root, ".omnyo-registry-skill.json"), "utf8")).toBe(
    "invalid user bytes",
  );
});

test("new provenance has one canonical writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-provenance-new-"));
  roots.push(root);
  await writeRegistrySkillProvenance({
    skillDirectoryPath: root,
    registrySkillId: "owned/skill",
  });
  expect(readRegistrySkillProvenance(root)).toBe("owned/skill");
  expect(
    JSON.parse(
      await readFile(join(root, ".omnyo-registry-skill.json"), "utf8"),
    ),
  ).toEqual({ version: 1, registrySkillId: "owned/skill" });
});
