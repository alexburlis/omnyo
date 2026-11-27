import { createHash } from "node:crypto";
import { maxPackBytes, packDigestSchema, skillPackSchema, type SkillPack } from "./pack.ts";

export interface PackArtifact {
  readonly text: string;
  readonly digest: string;
}

export function packArtifact(text: string): PackArtifact {
  if (Buffer.byteLength(text, "utf8") > maxPackBytes)
    throw new Error("Skill pack exceeds 768 KiB.");

  return { text, digest: createHash("sha256").update(text, "utf8").digest("hex") };
}

export function decodeSkillPack(artifact: PackArtifact): SkillPack {
  if (packArtifact(artifact.text).digest !== packDigestSchema.parse(artifact.digest)) {
    throw new Error("Skill pack contents do not match the reviewed SHA-256 digest.");
  }

  return skillPackSchema.parse(JSON.parse(artifact.text));
}

export function encodeSkillPack(pack: SkillPack): PackArtifact {
  return packArtifact(JSON.stringify(skillPackSchema.parse(pack)));
}
