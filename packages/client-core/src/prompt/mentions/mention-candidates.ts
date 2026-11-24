import type { PromptMentionSuggestion } from "./types.js";

export interface MentionCandidate {
  readonly suggestion: PromptMentionSuggestion;
  readonly visibleTitle: string;

  readonly identityTerms: readonly string[];
  readonly supportingTerms: readonly string[];
  readonly groupKey: string;
  readonly groupLabel: string;
}

export interface OrderedMentionSuggestionGroup {
  readonly key: string;
  readonly label: string;

  readonly startIndex: number;
  readonly suggestions: readonly PromptMentionSuggestion[];
}

export interface OrderedMentionSuggestions {
  readonly groups: readonly OrderedMentionSuggestionGroup[];
  readonly suggestions: readonly PromptMentionSuggestion[];
}

export const EMPTY_ORDERED_MENTION_SUGGESTIONS: OrderedMentionSuggestions = {
  groups: [],
  suggestions: [],
};

const MENTION_MATCH_RANK = {
  exact: 0,
  prefix: 1,
  substring: 2,
  supporting: 3,
  none: 4,
};

interface RankedMentionCandidate {
  candidate: MentionCandidate;
  inputIndex: number;
  matchRank: number;
}

interface RankedMentionCandidateGroup {
  key: string;
  label: string;
  inputIndex: number;
  bestMatchRank: number;
  candidates: RankedMentionCandidate[];
}

function normalizeMentionTerm(term: string): string {
  return term.trim().toLowerCase();
}

export function mentionIdentityMatchRank(
  identities: readonly string[],
  query: string,
): number {
  const normalizedQuery = normalizeMentionTerm(query);

  if (normalizedQuery.length === 0) return MENTION_MATCH_RANK.exact;

  const normalized = identities.map(normalizeMentionTerm);

  if (normalized.some((identity) => identity === normalizedQuery)) {
    return MENTION_MATCH_RANK.exact;
  }

  if (normalized.some((identity) => identity.startsWith(normalizedQuery))) {
    return MENTION_MATCH_RANK.prefix;
  }

  if (normalized.some((identity) => identity.includes(normalizedQuery))) {
    return MENTION_MATCH_RANK.substring;
  }

  return MENTION_MATCH_RANK.none;
}

function mentionCandidateMatchRank(
  candidate: MentionCandidate,
  normalizedQuery: string,
): number {
  const identityRank = mentionIdentityMatchRank(
    [candidate.visibleTitle, ...candidate.identityTerms],
    normalizedQuery,
  );

  if (identityRank !== MENTION_MATCH_RANK.none) {
    return identityRank;
  }

  const hasSupportingMatch = candidate.supportingTerms
    .map(normalizeMentionTerm)
    .some((term) => term.includes(normalizedQuery));

  return hasSupportingMatch
    ? MENTION_MATCH_RANK.supporting
    : MENTION_MATCH_RANK.none;
}

function compareRankedMentionCandidates(
  left: RankedMentionCandidate,
  right: RankedMentionCandidate,
): number {
  const byMatch = left.matchRank - right.matchRank;

  return byMatch !== 0 ? byMatch : left.inputIndex - right.inputIndex;
}

function compareRankedMentionCandidateGroups(
  left: RankedMentionCandidateGroup,
  right: RankedMentionCandidateGroup,
): number {
  const byBestMatch = left.bestMatchRank - right.bestMatchRank;

  return byBestMatch !== 0 ? byBestMatch : left.inputIndex - right.inputIndex;
}

export function orderMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): OrderedMentionSuggestions {
  const normalizedQuery = normalizeMentionTerm(query);
  const groupsByKey = new Map<string, RankedMentionCandidateGroup>();

  for (const [inputIndex, candidate] of candidates.entries()) {
    const rankedCandidate: RankedMentionCandidate = {
      candidate,
      inputIndex,
      matchRank: mentionCandidateMatchRank(candidate, normalizedQuery),
    };

    const existingGroup = groupsByKey.get(candidate.groupKey);

    if (existingGroup) {
      existingGroup.bestMatchRank = Math.min(
        existingGroup.bestMatchRank,
        rankedCandidate.matchRank,
      );
      existingGroup.candidates.push(rankedCandidate);
      continue;
    }

    groupsByKey.set(candidate.groupKey, {
      key: candidate.groupKey,
      label: candidate.groupLabel,
      inputIndex,
      bestMatchRank: rankedCandidate.matchRank,
      candidates: [rankedCandidate],
    });
  }

  let nextStartIndex = 0;

  const groups = [...groupsByKey.values()]
    .sort(compareRankedMentionCandidateGroups)
    .map<OrderedMentionSuggestionGroup>((group) => {
      const suggestions = group.candidates
        .sort(compareRankedMentionCandidates)
        .map(({ candidate }) => candidate.suggestion);

      const orderedGroup: OrderedMentionSuggestionGroup = {
        key: group.key,
        label: group.label,
        startIndex: nextStartIndex,
        suggestions,
      };

      nextStartIndex += suggestions.length;

      return orderedGroup;
    });

  const suggestions = groups.flatMap((group) => group.suggestions);

  return { groups, suggestions };
}
