import { readFileSync, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const REGISTRY_SKILL_PROVENANCE_FILE_NAME = ".omnyo-registry-skill.json";

const registrySkillProvenanceSchema = z
  .object({
    version: z.literal(1),
    registrySkillId: z.string().min(1),
  })
  .strict();

function readProvenanceFile(filePath: string): string | null {
  try {
    const info = lstatSync(filePath);

    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Registry skill provenance is not an ordinary file");

    return registrySkillProvenanceSchema.parse(
      JSON.parse(readFileSync(filePath, "utf8")),
    ).registrySkillId;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new Error(
      "Registry skill provenance is invalid; preserve its source",
      { cause: error },
    );
  }
}

export async function writeRegistrySkillProvenance(args: {
  registrySkillId: string;
  skillDirectoryPath: string;
}): Promise<void> {
  if (readRegistrySkillProvenance(args.skillDirectoryPath) !== null)
    throw new Error("Registry skill provenance already has an owner");

  const value = registrySkillProvenanceSchema.parse({
    version: 1,
    registrySkillId: args.registrySkillId,
  });

  await fs.writeFile(
    path.join(args.skillDirectoryPath, REGISTRY_SKILL_PROVENANCE_FILE_NAME),
    `${JSON.stringify(value)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o444 },
  );
}

export function readRegistrySkillProvenance(
  skillDirectoryPath: string,
): string | null {
  return readProvenanceFile(
    path.join(skillDirectoryPath, REGISTRY_SKILL_PROVENANCE_FILE_NAME),
  );
}
