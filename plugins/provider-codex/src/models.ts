import {
  reasoningEffortsForLevels,
  reasoningLevelSchema,
  type AvailableModel,
  type ModelReasoningEffort,
  type ModelServiceTier,
  type ReasoningLevel,
} from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";

const CODEX_FAST_SERVICE_TIER = "priority";

const OMNYO_FAST_SERVICE_TIER = "fast";

export const CODEX_DAYBREAK_OPTION_ID = "daybreak";

const CODEX_CYBER_PROGRAMS = [
  "standard",
  "daybreakBlue",
  "daybreakRed",
] as const;

const DAYBREAK_ALIAS_MODEL_PATTERN = /^gpt-daybreak-.+-latest$/u;

export function isDaybreakAliasModel(model: string): boolean {
  return DAYBREAK_ALIAS_MODEL_PATTERN.test(model);
}

export type CodexCyberProgram = (typeof CODEX_CYBER_PROGRAMS)[number];

export interface CodexModelCatalog {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  cyberProgramsByModel: Map<string, CodexCyberProgram[]>;
  daybreakAvailable: boolean;
}

const DEFAULT_REASONING_EFFORTS: readonly ModelReasoningEffort[] =
  reasoningEffortsForLevels(["low", "medium", "high", "xhigh"]);

const codexModelIdentitySchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
  })
  .passthrough();

function mapCodexReasoningLevelToOmnyo(value: unknown): ReasoningLevel | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = reasoningLevelSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function mapOmnyoReasoningLevelToCodex(
  level: ReasoningLevel,
): string | null {
  return level === "ultracode" ? null : level;
}

function cloneDefaultReasoningEfforts(): ModelReasoningEffort[] {
  return DEFAULT_REASONING_EFFORTS.map((effort) => ({ ...effort }));
}

function parseReasoningEffortOption(raw: unknown): ModelReasoningEffort | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const level = mapCodexReasoningLevelToOmnyo(record.reasoningEffort);

  if (!level) {
    return null;
  }

  const description =
    typeof record.description === "string" && record.description.length > 0
      ? record.description
      : reasoningEffortsForLevels([level])[0].description;

  return {
    reasoningEffort: level,
    description,
  };
}

function parseSupportedReasoningEfforts(raw: unknown): ModelReasoningEffort[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return cloneDefaultReasoningEfforts();
  }

  const efforts: ModelReasoningEffort[] = [];
  const seen = new Set<ReasoningLevel>();

  for (const item of raw) {
    const effort = parseReasoningEffortOption(item);

    if (!effort || seen.has(effort.reasoningEffort)) {
      continue;
    }

    seen.add(effort.reasoningEffort);
    efforts.push(effort);
  }

  return efforts.length > 0 ? efforts : cloneDefaultReasoningEfforts();
}

function mapCodexServiceTierToOmnyo(id: string): string {
  return id === CODEX_FAST_SERVICE_TIER ? OMNYO_FAST_SERVICE_TIER : id;
}

function parseServiceTierOption(raw: unknown): ModelServiceTier | null {
  if (typeof raw === "string") {
    return raw.length > 0 ? { id: mapCodexServiceTierToOmnyo(raw) } : null;
  }

  if (raw == null || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }

  return {
    id: mapCodexServiceTierToOmnyo(record.id),
    ...(typeof record.name === "string" && record.name.length > 0
      ? { label: record.name }
      : {}),
    ...(typeof record.description === "string" && record.description.length > 0
      ? { description: record.description }
      : {}),
  };
}

function parseSupportedServiceTiers(
  raw: z.infer<typeof codexModelIdentitySchema>,
): ModelServiceTier[] {
  const listed = Array.isArray(raw.serviceTiers)
    ? raw.serviceTiers
    : Array.isArray(raw.additionalSpeedTiers)
      ? raw.additionalSpeedTiers
      : null;

  if (listed === null) {
    return [{ id: OMNYO_FAST_SERVICE_TIER }];
  }

  const tiers: ModelServiceTier[] = [];
  const seen = new Set<string>();

  for (const item of listed) {
    const tier = parseServiceTierOption(item);

    if (!tier || seen.has(tier.id)) {
      continue;
    }

    seen.add(tier.id);
    tiers.push(tier);
  }

  return tiers;
}

function toAvailableModel(
  raw: z.infer<typeof codexModelIdentitySchema>,
): AvailableModel {
  const efforts = parseSupportedReasoningEfforts(raw.supportedReasoningEfforts);

  const mappedDefault = mapCodexReasoningLevelToOmnyo(
    raw.defaultReasoningEffort,
  );

  const defaultReasoningEffort =
    mappedDefault &&
    efforts.some((effort) => effort.reasoningEffort === mappedDefault)
      ? mappedDefault
      : efforts[0].reasoningEffort;

  return {
    id: raw.id,
    model: raw.model,
    displayName:
      typeof raw.displayName === "string" && raw.displayName.length > 0
        ? raw.displayName
        : raw.model,
    description: typeof raw.description === "string" ? raw.description : "",
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort,
    supportedServiceTiers: parseSupportedServiceTiers(raw),
    isDefault: raw.isDefault === true,
  };
}

function parseCyberPrograms(raw: unknown): CodexCyberProgram[] {
  if (raw == null || typeof raw !== "object") {
    return [];
  }

  const cyber = (raw as { cyber?: unknown }).cyber;

  if (!Array.isArray(cyber)) {
    return [];
  }

  return CODEX_CYBER_PROGRAMS.filter((program) => cyber.includes(program));
}

function daybreakProgram(
  programs: readonly CodexCyberProgram[],
): CodexCyberProgram | null {
  if (programs.includes("daybreakBlue")) {
    return "daybreakBlue";
  }

  return programs.includes("daybreakRed") ? "daybreakRed" : null;
}

export function cyberProgramForTurn(
  programs: readonly CodexCyberProgram[],
  daybreakEnabled: boolean,
): CodexCyberProgram | null {
  if (daybreakEnabled) {
    return daybreakProgram(programs);
  }

  return programs.includes("standard") ? "standard" : null;
}

export function parseModelCatalog(result: unknown): CodexModelCatalog {
  if (result == null || typeof result !== "object") {
    throw new Error("Invalid response from codex model/list.");
  }

  const data = (result as { data?: unknown }).data;

  if (!Array.isArray(data)) {
    throw new Error("Invalid response from codex model/list.");
  }

  const listed: AvailableModel[] = [];
  const cyberProgramsByModel = new Map<string, CodexCyberProgram[]>();

  for (const entry of data) {
    const identity = codexModelIdentitySchema.safeParse(entry);

    if (!identity.success) {
      continue;
    }

    const model = toAvailableModel(identity.data);
    listed.push(model);
    cyberProgramsByModel.set(
      model.model,
      parseCyberPrograms(identity.data.availableAccessPrograms),
    );
  }

  if (listed.length === 0) {
    throw new Error("Codex model/list returned no supported models.");
  }

  const programsFor = (model: AvailableModel): CodexCyberProgram[] =>
    cyberProgramsByModel.get(model.model) ?? [];

  const daybreakAvailable = listed.some(
    (model) => daybreakProgram(programsFor(model)) !== null,
  );

  return {
    models: listed,
    selectedOnlyModels: [],
    cyberProgramsByModel,
    daybreakAvailable,
  };
}
