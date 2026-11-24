import { describe, expect, it } from "vitest";
import { reasoningLevelLabel } from "@/lib/reasoning-labels";
import type { ModelPickerOption } from "./model-picker-option";
import {
  parseReasoningLevelToken,
  searchModelPickerGroups,
  type ModelPickerSearchGroup,
} from "./model-picker-search";

function row(
  value: string,
  label: string,
  levels: readonly string[],
): ModelPickerOption {
  return {
    value,
    label,
    reasoningOptions: levels.map((level) => ({
      value: level,
      label: reasoningLevelLabel(level, undefined),
    })),
    defaultReasoningLevel: levels[0] ?? "medium",
    serviceTierOptions: [],
  };
}

const codex: ModelPickerSearchGroup = {
  providerId: "codex",
  providerLabel: "Codex",
  brandPrefix: undefined,
  rows: [
    row("gpt-6.1-sol", "GPT-6.1-Sol", [
      "low",
      "medium",
      "high",
      "xhigh",
      "ultra",
    ]),
    row("gpt-6-astra", "GPT-6-Astra", ["low", "medium", "high", "xhigh"]),
    row("gpt-6-sol", "GPT-6-Sol", ["low", "medium", "high"]),
    row("gpt-6-luna", "GPT-6-Luna", ["low", "medium", "high", "xhigh"]),
    row("gpt-5.1-codex-max", "GPT-5.1-Codex-Max", ["medium", "high"]),
    row("gpt-5.6-terra", "GPT-5.6-Terra", ["low", "medium", "high"]),
  ],
  moreRows: [],
};

const claude: ModelPickerSearchGroup = {
  providerId: "claude-code",
  providerLabel: "Claude Code",
  brandPrefix: "Claude",
  rows: [
    row("claude-opus-5-5", "Claude Opus 5.5", [
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
      "max",
    ]),
    row("claude-fable-5-1", "Claude Fable 5.1", ["low", "medium", "high"]),
    row("claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]),
    row("claude-haiku-5-5", "Claude Haiku 5.5", ["low", "medium"]),
  ],
  moreRows: [],
};

function search(query: string, groups = [codex, claude]) {
  const result = searchModelPickerGroups(groups, query);

  return {
    reasoningLevel: result.reasoningLevel,
    groups: result.groups.map((group) => ({
      providerId: group.group.providerId,
      rows: group.rows.map((option) => option.value),
    })),
  };
}

const levels = [...codex.rows, ...claude.rows].flatMap(
  (option) => option.reasoningOptions,
);

describe("parseReasoningLevelToken", () => {
  it.each([
    ["sol xh", "sol", "xhigh"],
    ["sol XHIGH", "sol", "xhigh"],
    ["sol ultra", "sol", "ultra"],
    ["opus ultrac", "opus", "ultracode"],
    ["opus  MAX", "opus", "max"],
    ["codex astra med", "codex astra", "medium"],
    ["luna hi", "luna", "high"],
  ])("reads %s as model %s at %s", (query, modelQuery, reasoningLevel) => {
    expect(parseReasoningLevelToken(query, levels)).toEqual({
      modelQuery,
      reasoningLevel,
    });
  });

  it.each([
    ["sol u", "ambiguous between Ultra and Ultracode"],
    ["sol m", "ambiguous between Medium and Max"],
    ["xh", "a lone token is a model search"],
    ["sol terra", "not a reasoning level"],
    ["", "empty"],
  ])("leaves %s unparsed (%s)", (query) => {
    expect(parseReasoningLevelToken(query, levels)).toBeNull();
  });
});

describe("searchModelPickerGroups", () => {
  it("returns every group unchanged for an empty query", () => {
    expect(search("  ")).toEqual({
      reasoningLevel: null,
      groups: [
        { providerId: "codex", rows: codex.rows.map((option) => option.value) },
        {
          providerId: "claude-code",
          rows: claude.rows.map((option) => option.value),
        },
      ],
    });
  });

  it("lands on a parsed level and drops rows that lack it", () => {
    const result = search("sol xh");

    expect(result.reasoningLevel).toBe("xhigh");
    expect(result.groups).toEqual([
      { providerId: "codex", rows: ["gpt-6.1-sol"] },
    ]);
  });

  it("prefers an exact level id over a longer level it prefixes", () => {
    expect(search("sol ultra")).toEqual({
      reasoningLevel: "ultra",
      groups: [{ providerId: "codex", rows: ["gpt-6.1-sol"] }],
    });
    expect(search("opus ultrac")).toEqual({
      reasoningLevel: "ultracode",
      groups: [{ providerId: "claude-code", rows: ["claude-opus-5-5"] }],
    });
  });

  it("finds Claude Ultracode under the shared Ultra column", () => {
    expect(search("opus ultra")).toEqual({
      reasoningLevel: "ultra",
      groups: [{ providerId: "claude-code", rows: ["claude-opus-5-5"] }],
    });
  });

  it("treats an ambiguous trailing token as part of the model search", () => {
    expect(search("opus u")).toEqual({
      reasoningLevel: null,
      groups: [{ providerId: "claude-code", rows: ["claude-opus-5-5"] }],
    });
  });

  it("matches across providers by provider name, label and model id", () => {
    expect(search("codex luna").groups).toEqual([
      { providerId: "codex", rows: ["gpt-6-luna"] },
    ]);
    const claudeMatches = search("claude 5.5").groups;

    expect(claudeMatches.map((group) => group.providerId)).toEqual([
      "claude-code",
    ]);
    expect([...(claudeMatches[0]?.rows ?? [])].sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(search("claude-haiku").groups).toEqual([
      { providerId: "claude-code", rows: ["claude-haiku-5-5"] },
    ]);
  });

  it("matches the label without the brand prefix and finds folded models", () => {
    expect(search("terra").groups).toEqual([
      { providerId: "codex", rows: ["gpt-5.6-terra"] },
    ]);
    expect(search("opus").groups).toEqual([
      { providerId: "claude-code", rows: ["claude-opus-5-5"] },
    ]);
  });

  it("orders groups by their best match", () => {
    const result = search("code", [claude, codex]);

    expect(result.groups.map((group) => group.providerId)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(result.groups[0]?.rows[0]).toBe("gpt-5.1-codex-max");
  });

  it("ranks visible rows above folded ones and breaks equal matches by catalog order", () => {
    const xhighLadder = ["low", "medium", "high", "xhigh"];

    const storyCodex: ModelPickerSearchGroup = {
      providerId: "codex",
      providerLabel: "Codex",
      brandPrefix: "GPT-",
      rows: [
        row("gpt-6.1-sol", "GPT-6.1-Sol", xhighLadder),
        row("gpt-6-astra", "GPT-6-Astra", xhighLadder),
        row("gpt-6-sol", "GPT-6-Sol", xhighLadder),
        row("gpt-6-luna", "GPT-6-Luna", xhighLadder),
      ],
      moreRows: [
        row("gpt-5.6-sol", "GPT-5.6-Sol", xhighLadder),
        row("gpt-5.6-luna", "GPT-5.6-Luna", xhighLadder),
      ],
    };

    expect(search("sol xh", [storyCodex])).toEqual({
      reasoningLevel: "xhigh",
      groups: [
        {
          providerId: "codex",
          rows: ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
        },
      ],
    });
    expect(search("luna", [storyCodex]).groups[0]?.rows).toEqual([
      "gpt-6-luna",
      "gpt-5.6-luna",
    ]);
    expect(search("5.6-luna", [storyCodex]).groups[0]?.rows[0]).toBe(
      "gpt-5.6-luna",
    );
  });

  it("matches a route provider id", () => {
    const pi: ModelPickerSearchGroup = {
      providerId: "pi",
      providerLabel: "Pi",
      brandPrefix: undefined,
      rows: [
        {
          ...row("nvidia/nemotron-3-ultra", "NVIDIA: Nemotron 3 Ultra", []),
          routeProviderId: "openrouter",
        },
      ],
      moreRows: [],
    };

    expect(search("openrouter", [codex, pi]).groups).toEqual([
      { providerId: "pi", rows: ["nvidia/nemotron-3-ultra"] },
    ]);
  });
});
