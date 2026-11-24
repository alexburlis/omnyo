import { z } from "zod";
import {
  machineOsSchema,
  type MachineFacts,
  type MachineOs,
} from "./contract.js";

export const tagSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

export const needSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("os"), os: machineOsSchema }).strict(),
  z
    .object({ kind: z.literal("arch"), arch: z.enum(["arm64", "x64"]) })
    .strict(),
  z
    .object({ kind: z.literal("tool"), tool: z.enum(["xcode", "nvidia-gpu"]) })
    .strict(),
  z.object({ kind: z.literal("tag"), tag: tagSchema }).strict(),
]);

export type Need = z.infer<typeof needSchema>;

export const overflowHostSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    takesOverflow: z.boolean(),
    tags: z.array(tagSchema).max(20),
  })
  .strict();

export type OverflowHost = z.infer<typeof overflowHostSchema>;

export const projectNeedsSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    needs: z.array(needSchema).max(20),
  })
  .strict();

export type ProjectNeeds = z.infer<typeof projectNeedsSchema>;

export const overflowConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    hosts: z.array(overflowHostSchema).max(256),
    projectNeeds: z.array(projectNeedsSchema).max(512),
  })
  .strict();

export type OverflowConfiguration = z.infer<typeof overflowConfigurationSchema>;

export const DEFAULT_OVERFLOW: OverflowConfiguration = {
  enabled: false,
  hosts: [],
  projectNeeds: [],
};

export const NEED_TOKENS =
  "macos, windows, linux, arm64, x64, xcode, nvidia-gpu or tag:<name>";

export function parseNeedToken(raw: string): Need | null {
  const token = raw.trim().toLowerCase();

  if (token === "macos" || token === "windows" || token === "linux") {
    return { kind: "os", os: token };
  }

  if (token === "arm64" || token === "x64")
    return { kind: "arch", arch: token };

  if (token === "xcode" || token === "nvidia-gpu") {
    return { kind: "tool", tool: token };
  }

  if (token.startsWith("tag:")) {
    const parsed = needSchema.safeParse({ kind: "tag", tag: token.slice(4) });

    return parsed.success ? parsed.data : null;
  }

  return null;
}

export function formatNeed(need: Need): string {
  switch (need.kind) {
    case "os":
      return need.os;
    case "arch":
      return need.arch;
    case "tool":
      return need.tool;
    case "tag":
      return `tag:${need.tag}`;
  }
}

export function hostSetting(
  overflow: OverflowConfiguration,
  hostId: string,
): OverflowHost {
  return (
    overflow.hosts.find((host) => host.hostId === hostId) ?? {
      hostId,
      takesOverflow: true,
      tags: [],
    }
  );
}

export function declaredNeeds(
  overflow: OverflowConfiguration,
  projectId: string,
): Need[] | null {
  return (
    overflow.projectNeeds.find((entry) => entry.projectId === projectId)
      ?.needs ?? null
  );
}

function sameOs(os: MachineOs): Need[] {
  return [{ kind: "os", os }];
}

export function satisfiesNeed(
  need: Need,
  facts: MachineFacts,
  tags: readonly string[],
): boolean {
  switch (need.kind) {
    case "os":
      return facts.os === need.os;
    case "arch":
      return facts.arch === need.arch;
    case "tool":
      return need.tool === "xcode"
        ? facts.tools.xcode
        : facts.tools.nvidiaGpu !== null;
    case "tag":
      return tags.includes(need.tag);
  }
}

const HOME_MACHINE_WORDS =
  /\b(?:xcode|xcodebuild|ios|ipados|iphone|ipad|simulators?|testflight|app store|releases?|releasing|ship|shipping|deploy|deploying|notari[sz]e)\b/iu;

export function homeMachineWord(text: string): string | null {
  return HOME_MACHINE_WORDS.exec(text)?.[0] ?? null;
}

export interface OverflowCandidate {
  hostId: string;
  name: string;
}

export interface ChooseOverflowTargetInput {
  originHostId: string;
  projectId: string;
  candidates: readonly OverflowCandidate[];
  facts: ReadonlyMap<string, MachineFacts>;
  overflow: OverflowConfiguration;
  freeSlots: (hostId: string) => number;
}

export function chooseOverflowTarget(
  input: ChooseOverflowTargetInput,
): OverflowCandidate | null {
  if (!input.overflow.enabled) return null;
  const originFacts = input.facts.get(input.originHostId);

  const needs =
    declaredNeeds(input.overflow, input.projectId) ??
    (originFacts === undefined ? null : sameOs(originFacts.os));

  if (needs === null) return null;

  const ranked = input.candidates
    .filter((candidate) => candidate.hostId !== input.originHostId)
    .flatMap((candidate) => {
      const facts = input.facts.get(candidate.hostId);
      const setting = hostSetting(input.overflow, candidate.hostId);

      if (facts === undefined || !setting.takesOverflow) return [];

      if (!needs.every((need) => satisfiesNeed(need, facts, setting.tags))) {
        return [];
      }

      const free = input.freeSlots(candidate.hostId);

      return free > 0 ? [{ candidate, free }] : [];
    })
    .sort(
      (left, right) =>
        right.free - left.free ||
        left.candidate.name.localeCompare(right.candidate.name),
    );

  return ranked[0]?.candidate ?? null;
}
