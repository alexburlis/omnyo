import { fuzzyMatchText } from "@omnyo/fuzzy-match";
import type { ReasoningLevel } from "@omnyo/domain";
import { stripModelBrandPrefix } from "./model-brand-prefix";
import type { ModelPickerOption } from "./model-picker-option";
import type { PickerOption } from "./OptionPicker";
import { rowReasoningLevelInColumn } from "./model-picker-selection";

export interface ModelPickerSearchGroup<
  Row extends ModelPickerOption = ModelPickerOption,
> {
  providerId: string;
  providerLabel: string;
  brandPrefix: string | undefined;
  rows: readonly Row[];
  moreRows: readonly Row[];
}

export interface ModelPickerSearchResultGroup<
  Group extends ModelPickerSearchGroup,
> {
  group: Group;
  rows: readonly Group["rows"][number][];
}

export interface ModelPickerSearchResult<Group extends ModelPickerSearchGroup> {
  reasoningLevel: ReasoningLevel | null;
  groups: readonly ModelPickerSearchResultGroup<Group>[];
}

export interface ReasoningLevelToken {
  modelQuery: string;
  reasoningLevel: ReasoningLevel;
}

interface SearchCandidate<Group extends ModelPickerSearchGroup> {
  group: Group;
  groupIndex: number;
  order: number;
  folded: boolean;
  row: Group["rows"][number];
  label: string;
  qualityTexts: readonly string[];
  aliases: readonly string[];
}

interface RankedCandidate<Group extends ModelPickerSearchGroup> {
  candidate: SearchCandidate<Group>;
  quality: number;
}

const QUERY_TOKEN_SEPARATOR = /\s+/u;

const LABEL_WORD_SEPARATOR = /[\s\-_/:()[\]]+/u;

const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

const MATCH_QUALITY = {
  other: 1,
  contains: 2,
  wordPrefix: 3,
  exact: 4,
} as const;

type LevelMatch =
  | { kind: "none" }
  | { kind: "unique"; level: ReasoningLevel }
  | { kind: "ambiguous" };

function matchLevel(
  levels: ReadonlyMap<ReasoningLevel, readonly string[]>,
  matches: (text: string) => boolean,
): LevelMatch {
  const matched = [...levels.keys()].filter((level) =>
    (levels.get(level) ?? []).some(matches),
  );

  if (matched.length === 0) return { kind: "none" };

  return matched.length === 1
    ? { kind: "unique", level: matched[0] }
    : { kind: "ambiguous" };
}

export function parseReasoningLevelToken(
  query: string,
  levels: readonly PickerOption<ReasoningLevel>[],
): ReasoningLevelToken | null {
  const tokens = query.trim().split(QUERY_TOKEN_SEPARATOR);
  const token = tokens.at(-1)?.toLowerCase();

  if (tokens.length < 2 || token === undefined || token.length === 0) {
    return null;
  }

  const textsByLevel = new Map<ReasoningLevel, string[]>();

  for (const level of levels) {
    const texts = textsByLevel.get(level.value) ?? [];
    texts.push(level.value.toLowerCase(), level.label.toLowerCase());
    textsByLevel.set(level.value, texts);
  }

  const exact = matchLevel(textsByLevel, (text) => text === token);

  const match =
    exact.kind === "none"
      ? matchLevel(textsByLevel, (text) => text.startsWith(token))
      : exact;

  if (match.kind !== "unique") return null;

  return {
    modelQuery: tokens.slice(0, -1).join(" "),
    reasoningLevel: match.level,
  };
}

function textMatchQuality(text: string, token: string): number {
  const value = text.toLowerCase();
  const compactValue = value.replace(NON_ALPHANUMERIC, "");
  const compactToken = token.replace(NON_ALPHANUMERIC, "");
  const hasCompactToken = compactToken.length > 0;

  if (value === token || (hasCompactToken && compactValue === compactToken)) {
    return MATCH_QUALITY.exact;
  }

  if (
    value.split(LABEL_WORD_SEPARATOR).some((word) => word.startsWith(token)) ||
    (hasCompactToken && compactValue.startsWith(compactToken))
  ) {
    return MATCH_QUALITY.wordPrefix;
  }

  if (
    value.includes(token) ||
    (hasCompactToken && compactValue.includes(compactToken))
  ) {
    return MATCH_QUALITY.contains;
  }

  return MATCH_QUALITY.other;
}

function candidateQuality<Group extends ModelPickerSearchGroup>(
  candidate: SearchCandidate<Group>,
  tokens: readonly string[],
): number {
  return tokens.reduce((total, token) => {
    const normalizedToken = token.toLowerCase();

    return (
      total +
      Math.max(
        ...candidate.qualityTexts.map((text) =>
          textMatchQuality(text, normalizedToken),
        ),
      )
    );
  }, 0);
}

function rankCandidates<Group extends ModelPickerSearchGroup>(
  candidates: readonly SearchCandidate<Group>[],
  tokens: readonly string[],
): RankedCandidate<Group>[] {
  const matched = tokens.reduce<readonly SearchCandidate<Group>[]>(
    (remaining, token) =>
      fuzzyMatchText({
        items: remaining,
        query: token,
        getText: (candidate) => candidate.label,
        getAliases: (candidate) => candidate.aliases,
        limit: remaining.length,
      }).map((match) => match.item),
    candidates,
  );

  return matched
    .map((candidate) => ({
      candidate,
      quality: candidateQuality(candidate, tokens),
    }))
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        Number(left.candidate.folded) - Number(right.candidate.folded) ||
        left.candidate.order - right.candidate.order,
    );
}

export function searchModelPickerGroups<Group extends ModelPickerSearchGroup>(
  groups: readonly Group[],
  query: string,
): ModelPickerSearchResult<Group> {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length === 0) {
    return {
      reasoningLevel: null,
      groups: groups.map((group) => ({
        group,
        rows: [...group.rows, ...group.moreRows],
      })),
    };
  }

  const levelToken = parseReasoningLevelToken(
    normalizedQuery,
    groups.flatMap((group) =>
      [...group.rows, ...group.moreRows].flatMap((row) => row.reasoningOptions),
    ),
  );

  const reasoningLevel = levelToken?.reasoningLevel ?? null;

  const tokens = (levelToken?.modelQuery ?? normalizedQuery)
    .split(QUERY_TOKEN_SEPARATOR)
    .filter((token) => token.length > 0);

  const candidates = groups
    .flatMap((group, groupIndex) => [
      ...group.rows.map((row) => ({ group, groupIndex, row, folded: false })),
      ...group.moreRows.map((row) => ({
        group,
        groupIndex,
        row,
        folded: true,
      })),
    ])
    .filter(
      ({ row }) =>
        reasoningLevel === null ||
        rowReasoningLevelInColumn(row, reasoningLevel) !== null,
    )
    .map(
      ({ group, groupIndex, row, folded }, order): SearchCandidate<Group> => {
        const label = stripModelBrandPrefix(row.label, group.brandPrefix);

        return {
          group,
          groupIndex,
          order,
          folded,
          row,
          label,
          qualityTexts: label === row.label ? [label] : [label, row.label],
          aliases: [
            ...(row.routeProviderId ? [row.routeProviderId] : []),
            row.value,
            group.providerLabel,
          ],
        };
      },
    );

  const ranked = rankCandidates(candidates, tokens);
  const resultGroups = new Map<number, ModelPickerSearchResultGroup<Group>>();

  for (const { candidate } of ranked) {
    const existing = resultGroups.get(candidate.groupIndex);

    if (existing === undefined) {
      resultGroups.set(candidate.groupIndex, {
        group: candidate.group,
        rows: [candidate.row],
      });
      continue;
    }

    resultGroups.set(candidate.groupIndex, {
      group: existing.group,
      rows: [...existing.rows, candidate.row],
    });
  }

  return { reasoningLevel, groups: [...resultGroups.values()] };
}
